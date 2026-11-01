// 정리 서비스 (ARCHITECTURE.md §7.1): plan(미리보기, 삭제 없음) → 확인 토큰 → execute(실제 삭제).
// 6단계에서는 UI/IPC 에 연결하지 않는다. 모든 삭제는 Remover.deleteTarget(= safety 관문)을 거친다.
import { randomUUID } from 'node:crypto'
import type {
  CleanupItem,
  CleanupItemResult,
  CleanupMode,
  CleanupPlan,
  CleanupPlanItem,
  CleanupProgress,
  CleanupResult,
  SkipReason
} from '../../shared/cleanup.ts'
import type { AdminCleanupPort, AdminRunOutcome } from '../helper/types.ts'
import { AppError } from '../ipc/errors.ts'
import type { LoadedRule } from '../rules/matcher.ts'
import {
  planDigest,
  type ConfirmationStore,
  type ConsumeFailure,
  type ExecutionPermit
} from '../safety/confirmation.ts'
import { judgeRule, type DeleteGuard, type GuardSettings } from '../safety/deleteGuard.ts'
import type { FsReader } from '../safety/fsReader.ts'
import type { CleanupHistory } from './history.ts'
import type { CleanupLogger, LogEntry } from './log.ts'
import type { Remover } from './remover.ts'
import { enumerateTargets, resolveRoots } from './targets.ts'

/** 파일을 직접 지우지 않는 전용 동작 (SAFETY.md §5). 6단계는 인터페이스만 있고 실제 구현은 이후 단계다 */
export interface SpecialActionPort {
  emptyRecycleBin(): Promise<void>
  runDiskCleanup(): Promise<void>
}

export interface CleanupServiceDeps {
  /** 로드된 경로 규칙 전체 (matcher.rules). 정리 항목은 여기서 cleanable 인 것만 뽑는다 */
  rules: readonly LoadedRule[]
  guard: DeleteGuard
  remover: Remover
  fs: FsReader
  confirmations: ConfirmationStore
  logger: CleanupLogger
  history: CleanupHistory
  settings: GuardSettings
  /** 없으면 전용 동작 항목은 항상 '건너뜀(other)'이다 */
  special?: SpecialActionPort
  /** 관리자 권한 항목을 UAC 헬퍼로 실행하는 포트. 없으면 관리자 항목은 '건너뜀(admin-declined)'이다 */
  admin?: AdminCleanupPort
  /**
   * 이 프로세스가 UAC 로 상승해 실행된 관리자 헬퍼다 (helper/runHelper.ts 만 true 로 만든다).
   * true 이면 관리자 항목을 헬퍼 자신이 처리한다. 허용 항목은 헬퍼의 하드코딩 규칙으로만 구성되므로 다른 곳은 지울 수 없다.
   */
  isElevatedHelper?: boolean
  now?: () => number
  newId?: () => string
  onProgress?: (progress: CleanupProgress) => void
}

export interface ExecuteRequest {
  planId: string
  confirmationId: string
  acknowledgeCaution: boolean
}

interface StoredPlan {
  plan: CleanupPlan
  rules: LoadedRule[]
}

const MAX_STORED_PLANS = 8
const PROGRESS_EVERY = 25

const CONFIRM_MESSAGES: Record<ConsumeFailure, string> = {
  unknown: '확인 토큰이 올바르지 않습니다.',
  used: '이미 사용한 확인 토큰입니다. 미리보기부터 다시 하세요.',
  expired: '확인 시간이 지났습니다. 미리보기부터 다시 하세요.',
  'plan-mismatch': '이 계획의 확인 토큰이 아닙니다.',
  'plan-changed': '계획 내용이 확인 이후 바뀌었습니다. 미리보기부터 다시 하세요.',
  'caution-not-acknowledged': '주의(caution) 항목은 경고를 확인해야 실행할 수 있습니다.'
}

export function isCleanable(rule: LoadedRule): boolean {
  return rule.rule.cleanable && rule.rule.cleanup !== undefined && rule.rule.safety !== 'protected'
}

export function toCleanupItem(rule: LoadedRule): CleanupItem {
  const cleanup = rule.rule.cleanup
  if (!cleanup || (rule.rule.safety !== 'safe' && rule.rule.safety !== 'caution')) {
    throw new Error(`정리 항목이 아닌 규칙입니다: ${rule.rule.id}`)
  }
  const item: CleanupItem = {
    itemId: rule.rule.id,
    name: rule.rule.name,
    group: cleanup.group,
    description: rule.rule.description,
    impact: rule.rule.impact,
    safety: rule.rule.safety,
    estimatedBytes: null,
    fileCount: null,
    requiresAdmin: cleanup.requiresAdmin,
    allowPermanent: cleanup.allowPermanent,
    // caution 은 원클릭 정리에 포함하지 않는다 (SAFETY.md §2)
    defaultSelected: cleanup.defaultSelected && rule.rule.safety === 'safe'
  }
  if (cleanup.needsProcessClosed) item.needsProcessClosed = cleanup.needsProcessClosed
  if (cleanup.specialAction) item.specialAction = cleanup.specialAction
  return item
}

export class CleanupService {
  readonly #d: CleanupServiceDeps
  readonly #byId = new Map<string, LoadedRule>()
  readonly #plans = new Map<string, StoredPlan>()
  #running: { cancelled: boolean; jobId: string } | null = null

  constructor(deps: CleanupServiceDeps) {
    this.#d = deps
    for (const rule of deps.rules) if (isCleanable(rule)) this.#byId.set(rule.rule.id, rule)
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  #newId(): string {
    return (this.#d.newId ?? randomUUID)()
  }

  listItems(): CleanupItem[] {
    return [...this.#byId.values()].map(toCleanupItem)
  }

  /** 미리보기: 대상 파일 수/용량을 계산한다. 아무것도 지우지 않는다 */
  async plan(itemIds: readonly string[], mode: CleanupMode): Promise<CleanupPlan> {
    const ids = [...new Set(itemIds)]
    if (ids.length === 0) throw new AppError('INVALID_REQUEST', '정리할 항목을 선택하세요.')
    const rules: LoadedRule[] = []
    for (const id of ids) {
      const rule = this.#byId.get(id)
      if (!rule) throw new AppError('NOT_FOUND', `정리할 수 없는 항목입니다: ${id}`)
      if (rule.rule.cleanup?.specialAction && !this.#d.special) {
        throw new AppError('NOT_FOUND', `${rule.rule.name}: 이 항목은 아직 지원되지 않습니다.`)
      }
      // 전용 동작 항목은 파일 삭제 조건을 적용하지 않는다 (실행 때 별도 경로)
      if (!rule.rule.cleanup?.specialAction) {
        const denied = judgeRule(rule, mode, true, this.#d.settings.allowPermanentDelete())
        if (denied && !denied.allowed) {
          throw new AppError('SAFETY_DENIED', `${rule.rule.name}: ${denied.detail}`)
        }
      }
      rules.push(rule)
    }

    const items: CleanupPlanItem[] = []
    for (const rule of rules) items.push(await this.#measure(rule, mode))

    const planId = this.#newId()
    const base = {
      planId,
      mode,
      items,
      totalFiles: items.reduce((s, i) => s + i.fileCount, 0),
      totalBytes: items.reduce((s, i) => s + i.bytes, 0),
      requiresAdmin: rules.some((r) => r.rule.cleanup?.requiresAdmin === true),
      needsCautionAck: rules.some((r) => r.rule.safety === 'caution')
    }
    const token = this.#d.confirmations.issue({ planId, digest: planDigest(base) })
    const plan: CleanupPlan = {
      ...base,
      confirmationId: token.confirmationId,
      expiresAt: new Date(token.expiresAt).toISOString()
    }
    this.#plans.set(planId, { plan: structuredClone(plan), rules })
    while (this.#plans.size > MAX_STORED_PLANS) {
      const oldest = this.#plans.keys().next().value
      if (oldest === undefined) break
      this.#plans.delete(oldest)
    }
    return plan
  }

  async #measure(rule: LoadedRule, mode: CleanupMode): Promise<CleanupPlanItem> {
    const cleanup = rule.rule.cleanup
    const warnings: string[] = []
    if (rule.rule.safety === 'caution') warnings.push(rule.rule.impact)
    if (cleanup?.needsProcessClosed?.length) {
      warnings.push(
        `${cleanup.needsProcessClosed.join(', ')} 실행 중이면 일부 파일이 건너뛰어집니다.`
      )
    }
    if (cleanup?.requiresAdmin && !cleanup.specialAction && !this.#d.isElevatedHelper) {
      warnings.push(
        '관리자 권한(UAC)으로 실행됩니다. 일반 권한으로 볼 수 없는 파일이 있어 미리보기 수치는 실제와 다를 수 있습니다.'
      )
    }
    if (cleanup?.specialAction) {
      warnings.push('파일을 직접 지우지 않고 Windows 전용 기능으로 처리합니다.')
      return { itemId: rule.rule.id, fileCount: 0, bytes: 0, sample: [], warnings }
    }
    let fileCount = 0
    let bytes = 0
    let excluded = 0
    const biggest: Array<{ path: string; size: number }> = []
    for (const root of await resolveRoots(rule, this.#d.fs)) {
      for await (const event of enumerateTargets(rule, root, this.#d.fs, this.#now())) {
        if (event.type === 'link') excluded++
        else if (event.type === 'error') excluded++
        else if (event.type === 'file') {
          const verdict = await this.#d.guard.evaluate(event.path, rule, mode, true)
          if (verdict.allowed) {
            fileCount++
            bytes += event.size
            biggest.push({ path: event.path, size: event.size })
            biggest.sort((a, b) => b.size - a.size)
            if (biggest.length > 3) biggest.pop()
          } else excluded++
        }
      }
    }
    if (excluded > 0) warnings.push(`${excluded}개 항목은 안전 검사 또는 접근 문제로 제외됩니다.`)
    return { itemId: rule.rule.id, fileCount, bytes, sample: biggest.map((b) => b.path), warnings }
  }

  /** 분석: 항목 하나의 대상 수/용량을 계산한다 (삭제 없음, 확인 토큰 없음). 정리 화면의 [분석하기]용 */
  async analyze(itemId: string): Promise<CleanupPlanItem> {
    const rule = this.#byId.get(itemId)
    if (!rule || (rule.rule.cleanup?.specialAction && !this.#d.special)) {
      throw new AppError('NOT_FOUND', `분석할 수 없는 항목입니다: ${itemId}`)
    }
    return this.#measure(rule, 'trash')
  }

  /** 진행 중인 정리를 중단한다. jobId 를 주면 그 작업일 때만. 이미 지운 것은 기록에 남고 나머지는 하지 않는다 */
  cancel(jobId?: string): boolean {
    if (!this.#running) return false
    if (jobId !== undefined && jobId !== this.#running.jobId) return false
    this.#running.cancelled = true
    try {
      this.#d.admin?.requestCancel(this.#running.jobId)
    } catch {
      // 헬퍼에 취소를 알리지 못해도 이 프로세스의 작업은 멈춘다
    }
    return true
  }

  /** 확인 토큰을 소비하고 정리를 끝까지 실행한다 (테스트·CLI용). UI 는 start 로 시작하고 완료 이벤트를 받는다 */
  async execute(request: ExecuteRequest): Promise<CleanupResult> {
    return (await this.start(request)).done
  }

  /**
   * 확인 토큰을 소비하고 정리를 시작한다. 토큰/계획 검증은 여기서 끝나며 실패하면 예외다.
   * 반환된 done 은 작업이 끝나면 결과로 이행된다 (취소·건너뜀도 결과에 담기며 reject 되지 않는다).
   */
  async start(request: ExecuteRequest): Promise<{ jobId: string; done: Promise<CleanupResult> }> {
    if (this.#running) throw new AppError('BUSY', '이미 진행 중인 정리가 있습니다.')
    const stored = this.#plans.get(request.planId)
    if (!stored)
      throw new AppError('NOT_FOUND', '미리보기(계획)를 찾을 수 없습니다. 다시 미리보기를 하세요.')
    const { plan, rules } = stored

    const consumed = this.#d.confirmations.consume({
      planId: plan.planId,
      confirmationId: request.confirmationId,
      digest: planDigest(plan),
      mode: plan.mode,
      itemIds: plan.items.map((i) => i.itemId),
      needsCautionAck: plan.needsCautionAck,
      acknowledgeCaution: request.acknowledgeCaution
    })
    if (!consumed.ok) {
      await this.#tryLog({
        op: 'confirm',
        result: 'denied',
        reason: consumed.reason,
        detail: plan.planId
      })
      throw new AppError('SAFETY_DENIED', CONFIRM_MESSAGES[consumed.reason])
    }
    this.#plans.delete(plan.planId) // 계획은 한 번만 실행할 수 있다

    const jobId = this.#newId()
    const state = { cancelled: false, jobId }
    this.#running = state
    const done = this.#run(plan, rules, consumed.permit, state).finally(() => {
      this.#running = null
    })
    return { jobId, done }
  }

  async #run(
    plan: CleanupPlan,
    rules: LoadedRule[],
    permit: ExecutionPermit,
    state: { cancelled: boolean; jobId: string }
  ): Promise<CleanupResult> {
    const { jobId } = state
    const startedAt = new Date(this.#now()).toISOString()
    const perItem: CleanupItemResult[] = []
    let adminBatch: Map<string, CleanupItemResult> | null = null
    let logError: string | undefined
    const log = async (entry: LogEntry): Promise<void> => {
      try {
        await this.#d.logger.write({ jobId, mode: plan.mode, ...entry })
      } catch (error) {
        // 기록할 수 없으면 더 지우지 않는다 (SAFETY.md §1-5: 모든 삭제는 기록한다)
        logError ??= error instanceof Error ? error.message : '로그를 쓰지 못했습니다.'
        state.cancelled = true
      }
    }
    await log({ op: 'job', result: 'start', detail: plan.items.map((i) => i.itemId).join(',') })

    for (const rule of rules) {
      if (state.cancelled) break
      const result: CleanupItemResult = {
        itemId: rule.rule.id,
        freedBytes: 0,
        deletedFiles: 0,
        skipped: []
      }
      perItem.push(result)
      const skip = (reason: SkipReason): void => {
        const found = result.skipped.find((s) => s.reason === reason)
        if (found) found.count++
        else result.skipped.push({ reason, count: 1 })
      }
      const cleanup = rule.rule.cleanup

      if (cleanup?.requiresAdmin && !this.#d.isElevatedHelper && !cleanup.specialAction) {
        // 관리자 권한 정리는 UAC 헬퍼만 한다. 이 프로세스에서는 건드리지 않는다 (헬퍼 포트가 없으면 건너뜀)
        if (!this.#d.admin) {
          skip('admin-declined')
          await log({
            op: 'delete',
            result: 'skipped',
            reason: 'admin-declined',
            ruleId: rule.rule.id
          })
          continue
        }
        // 관리자 항목은 UAC 를 한 번만 띄우도록 묶어서 한 번에 실행한다
        adminBatch ??= await this.#runAdminBatch(plan, rules, permit, state, log)
        const fromHelper = adminBatch.get(rule.rule.id)
        if (fromHelper) {
          result.freedBytes = fromHelper.freedBytes
          result.deletedFiles = fromHelper.deletedFiles
          result.skipped = fromHelper.skipped
        }
        continue
      }
      if (cleanup?.requiresAdmin && cleanup.specialAction) {
        // 관리자 권한이 필요한 전용 동작(디스크 정리)은 아직 지원하지 않는다
        skip('admin-declined')
        await log({
          op: 'delete',
          result: 'skipped',
          reason: 'admin-declined',
          ruleId: rule.rule.id
        })
        continue
      }
      if (cleanup?.specialAction) {
        await this.#runSpecial(rule, skip, log)
        continue
      }

      let processed = 0
      const report = (current?: string): void => {
        const progress: CleanupProgress = {
          jobId,
          itemId: rule.rule.id,
          processedFiles: processed,
          freedBytes: result.freedBytes
        }
        if (current !== undefined) progress.currentPath = current
        this.#d.onProgress?.(progress)
      }

      for (const root of await resolveRoots(rule, this.#d.fs)) {
        if (state.cancelled) break
        for await (const event of enumerateTargets(rule, root, this.#d.fs, this.#now())) {
          if (state.cancelled) break
          if (event.type === 'link') {
            skip('link')
            await log({
              op: 'delete',
              result: 'skipped',
              reason: 'link',
              path: event.path,
              ruleId: rule.rule.id
            })
            continue
          }
          if (event.type === 'error') {
            skip(
              event.code === 'ENOENT'
                ? 'not-found'
                : event.code === 'EPERM' || event.code === 'EACCES'
                  ? 'permission-denied'
                  : 'other'
            )
            await log({
              op: 'delete',
              result: 'error',
              reason: event.code,
              path: event.path,
              ruleId: rule.rule.id
            })
            continue
          }
          const kind = event.type === 'file' ? 'file' : 'dir'
          const outcome = await this.#d.remover.deleteTarget({
            path: event.path,
            rule,
            mode: plan.mode,
            permit,
            kind
          })
          if (outcome.ok) {
            if (event.type === 'file') {
              result.deletedFiles++
              result.freedBytes += event.size
              processed++
              if (processed % PROGRESS_EVERY === 0) report(event.path)
            }
            await log({
              op: 'delete',
              result: 'ok',
              path: event.path,
              bytes: event.type === 'file' ? event.size : 0,
              ruleId: rule.rule.id
            })
          } else if (outcome.reason === 'not-empty') {
            // 제외된 파일이 남은 폴더는 그대로 둔다 (정상)
          } else {
            skip(outcome.skip)
            await log({
              op: 'delete',
              result:
                outcome.skip === 'safety-denied'
                  ? 'denied'
                  : outcome.skip === 'other'
                    ? 'error'
                    : 'skipped',
              reason: outcome.reason,
              path: event.path,
              ruleId: rule.rule.id,
              detail: outcome.detail
            })
          }
        }
      }
      report()
    }

    const finishedAt = new Date(this.#now()).toISOString()
    const freedBytes = perItem.reduce((s, i) => s + i.freedBytes, 0)
    const deletedFiles = perItem.reduce((s, i) => s + i.deletedFiles, 0)
    const skippedFiles = perItem.reduce((s, i) => s + i.skipped.reduce((n, k) => n + k.count, 0), 0)
    const result: CleanupResult = {
      jobId,
      startedAt,
      finishedAt,
      mode: plan.mode,
      freedBytes,
      deletedFiles,
      skippedFiles,
      cancelled: state.cancelled,
      perItem
    }
    if (logError !== undefined) result.error = `로그를 쓸 수 없어 중단했습니다: ${logError}`
    await log({
      op: 'job',
      result: 'end',
      bytes: freedBytes,
      detail: `deleted=${deletedFiles} skipped=${skippedFiles} cancelled=${state.cancelled}`
    })
    try {
      await this.#d.history.add({
        jobId,
        at: finishedAt,
        mode: plan.mode,
        freedBytes,
        itemIds: perItem.map((i) => i.itemId),
        deletedFiles,
        skippedFiles,
        cancelled: state.cancelled,
        perItem
      })
    } catch (error) {
      result.error ??= `정리 기록을 저장하지 못했습니다: ${error instanceof Error ? error.message : ''}`
    }
    return result
  }

  /** 관리자 항목 전체를 헬퍼에 맡긴다. 거부·실패는 항목별 '건너뜀'으로 바꿔 돌려준다 (앱은 정상 동작) */
  async #runAdminBatch(
    plan: CleanupPlan,
    rules: LoadedRule[],
    permit: ExecutionPermit,
    state: { cancelled: boolean; jobId: string },
    log: (entry: LogEntry) => Promise<void>
  ): Promise<Map<string, CleanupItemResult>> {
    const adminIds = rules
      .filter((r) => r.rule.cleanup?.requiresAdmin && !r.rule.cleanup.specialAction)
      .map((r) => r.rule.id)
    const out = new Map<string, CleanupItemResult>()
    const skipAll = (reason: SkipReason): void => {
      for (const itemId of adminIds) {
        out.set(itemId, { itemId, freedBytes: 0, deletedFiles: 0, skipped: [{ reason, count: 1 }] })
      }
    }
    const port = this.#d.admin
    const first = adminIds[0]
    if (!port || first === undefined) {
      skipAll('admin-declined')
      return out
    }
    this.#d.onProgress?.({ jobId: state.jobId, itemId: first, processedFiles: 0, freedBytes: 0 })
    await log({ op: 'admin', result: 'start', detail: adminIds.join(',') })
    let outcome: AdminRunOutcome
    try {
      outcome = await port.run({
        jobId: state.jobId,
        itemIds: adminIds,
        mode: plan.mode,
        acknowledgeCaution: permit.acknowledgeCaution
      })
    } catch (error) {
      outcome = {
        kind: 'failed',
        detail: error instanceof Error ? error.message : '알 수 없는 오류'
      }
    }

    if (outcome.kind === 'declined') {
      skipAll('admin-declined')
      await log({
        op: 'admin',
        result: 'skipped',
        reason: 'admin-declined',
        detail: adminIds.join(',')
      })
    } else if (outcome.kind === 'failed') {
      skipAll('other')
      await log({ op: 'admin', result: 'error', reason: 'helper-failed', detail: outcome.detail })
    } else {
      // 헬퍼가 돌려준 결과는 "우리가 요청한 항목"에 대한 것만 받는다 (그 밖의 항목 ID 는 무시)
      for (const item of outcome.perItem) {
        if (adminIds.includes(item.itemId) && !out.has(item.itemId)) out.set(item.itemId, item)
      }
      for (const itemId of adminIds) {
        if (!out.has(itemId)) {
          out.set(itemId, {
            itemId,
            freedBytes: 0,
            deletedFiles: 0,
            skipped: [{ reason: 'other', count: 1 }]
          })
        }
      }
      if (outcome.cancelled) state.cancelled = true
      await log({
        op: 'admin',
        result: 'end',
        bytes: [...out.values()].reduce((n, i) => n + i.freedBytes, 0),
        detail: 'cancelled=' + String(outcome.cancelled)
      })
    }
    return out
  }

  async #runSpecial(
    rule: LoadedRule,
    skip: (reason: SkipReason) => void,
    log: (entry: LogEntry) => Promise<void>
  ): Promise<void> {
    const action = rule.rule.cleanup?.specialAction
    const port = this.#d.special
    if (!port || !action) {
      skip('other')
      await log({ op: 'special', result: 'skipped', reason: 'not-available', ruleId: rule.rule.id })
      return
    }
    try {
      if (action === 'empty-recycle-bin') await port.emptyRecycleBin()
      else await port.runDiskCleanup()
      await log({ op: 'special', result: 'ok', detail: action, ruleId: rule.rule.id })
    } catch (error) {
      skip('other')
      await log({
        op: 'special',
        result: 'error',
        detail: error instanceof Error ? error.message : action,
        ruleId: rule.rule.id
      })
    }
  }

  async #tryLog(entry: LogEntry): Promise<void> {
    try {
      await this.#d.logger.write(entry)
    } catch {
      // 거부 기록 실패는 거부 자체에 영향을 주지 않는다 (이미 실행하지 않음)
    }
  }
}
