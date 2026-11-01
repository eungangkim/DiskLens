// 프로그램 제거 서비스 (SAFETY.md §6). 흐름: plan(미리보기+확인 토큰) → start(토큰 소비, 공식 제거 프로그램 실행) → 결과.
// - 하는 일은 "그 프로그램의 공식 제거 프로그램 실행"뿐이다. 폴더·파일·레지스트리를 직접 지우거나 쓰지 않는다 (남은 폴더는 알려 주기만 한다).
// - 실행할 명령은 레지스트리의 UninstallString 만 쓰고(QuietUninstallString 은 쓰지 않는다), 실행 직전에 다시 읽어 검사한다.
// - 모든 실행은 ProcessPort 로 주입한다: 테스트는 모의 제거 프로그램만 돌린다.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import type { UninstallPlan, UninstallResult, UninstallStatus } from '../../shared/uninstall.ts'
import type { CleanupLogger, LogEntry } from '../cleaner/log.ts'
import type { ElevationPort } from '../helper/elevation.ts'
import { AppError } from '../ipc/errors.ts'
import { ConfirmationStore, type ConsumeFailure } from '../safety/confirmation.ts'
import { parseUninstallCommand, type CommandEnv, type ParsedUninstallCommand } from './command.ts'
import type { ProgramService, ScanLocator } from './service.ts'

export type ProcessOutcome =
  /** 프로세스가 끝났다 (종료 코드) */
  | { kind: 'exited'; code: number }
  /** 프로세스를 시작하지 못했다 (코드는 Node 오류 코드: ENOENT, EACCES, UNKNOWN …) */
  | { kind: 'spawn-error'; code: string; message: string }

export interface ProcessPort {
  run(exe: string, args: readonly string[]): Promise<ProcessOutcome>
}

/**
 * 실제 실행: shell 없이 spawn 한다. 실행 파일과 인자는 분리해서 넘기므로 명령 연결이 해석되지 않는다.
 * 제거 프로그램은 자기 창을 띄우므로 stdio 는 쓰지 않는다. 끝날 때까지 기다린다 (취소 기능은 없다: 제거 도중에 죽이면 위험하다).
 */
export function createNodeProcessPort(spawnFn: typeof spawn = spawn): ProcessPort {
  return {
    run(exe, args) {
      return new Promise((resolve) => {
        let child
        try {
          child = spawnFn(exe, [...args], {
            shell: false,
            stdio: 'ignore',
            windowsHide: false,
            cwd: dirname(exe)
          })
        } catch (error) {
          const e = error as NodeJS.ErrnoException
          resolve({ kind: 'spawn-error', code: String(e.code ?? 'UNKNOWN'), message: e.message })
          return
        }
        child.once('error', (error: NodeJS.ErrnoException) => {
          resolve({
            kind: 'spawn-error',
            code: String(error.code ?? 'UNKNOWN'),
            message: error.message
          })
        })
        child.once('close', (code) => resolve({ kind: 'exited', code: code ?? -1 }))
      })
    }
  }
}

/** 관리자 권한이 필요해 일반 실행이 거부된 것으로 보는 오류 코드 (ERROR_ELEVATION_REQUIRED 는 Node 에서 UNKNOWN/EACCES) */
const ELEVATION_ERRORS = new Set(['UNKNOWN', 'EACCES', 'EPERM'])

export interface UninstallServiceDeps {
  programs: ProgramService
  env: CommandEnv
  process: ProcessPort
  /** 없으면 관리자 권한 재시도를 하지 않는다 (개발/E2E 가짜 드라이브) */
  elevation?: ElevationPort
  confirmations?: ConfirmationStore
  logger: CleanupLogger
  scan?: ScanLocator
  /** 폴더가 있는지 (남은 폴더 알림용) */
  dirExists(path: string): boolean
  now?: () => number
  newId?: () => string
}

interface StoredPlan {
  planId: string
  digest: string
  needsAck: boolean
}

const MAX_STORED = 8

const CONFIRM_MESSAGES: Record<ConsumeFailure, string> = {
  unknown: '확인 토큰이 올바르지 않습니다.',
  used: '이미 사용한 확인 토큰입니다. 제거를 처음부터 다시 시작하세요.',
  expired: '확인 시간이 지났습니다. 제거를 처음부터 다시 시작하세요.',
  'plan-mismatch': '이 제거 계획의 확인 토큰이 아닙니다.',
  'plan-changed': '제거 명령이 확인 이후 바뀌었습니다. 제거를 처음부터 다시 시작하세요.',
  'caution-not-acknowledged': '주의가 필요한 프로그램은 경고를 확인해야 제거할 수 있습니다.'
}

const COMMAND_MESSAGES: Record<string, string> = {
  empty: '이 프로그램에는 제거 명령이 없습니다.',
  'not-found':
    '제거 프로그램 파일을 찾을 수 없습니다. 이미 지워졌거나 설치가 손상됐을 수 있습니다.',
  'blocked-program': '안전을 위해 지원하지 않는 형식의 제거 명령입니다.',
  ambiguous: '제거 프로그램 위치가 명확하지 않아 실행하지 않습니다.'
}

/** 제거 명령의 지문: 계획 이후 레지스트리 값이 바뀌면 달라진다 */
function fingerprint(programId: string, command: ParsedUninstallCommand): string {
  return createHash('sha256')
    .update([programId, command.kind, command.exe.toLowerCase(), ...command.args].join('\u0001'))
    .digest('hex')
}

/** 종료 코드 해석. 3010/1641 은 성공(재부팅 필요), 1602/1223 은 사용자가 제거 프로그램에서 취소 */
export function interpretExitCode(code: number): {
  status: UninstallStatus
  rebootRequired: boolean
  message: string
} {
  if (code === 0)
    return {
      status: 'finished',
      rebootRequired: false,
      message: '제거 프로그램이 정상으로 끝났습니다.'
    }
  if (code === 3010 || code === 1641) {
    return {
      status: 'finished',
      rebootRequired: true,
      message: '제거가 끝났습니다. 완전히 마치려면 컴퓨터를 다시 시작해야 합니다.'
    }
  }
  if (code === 1602 || code === 1223) {
    return {
      status: 'cancelled',
      rebootRequired: false,
      message: '제거 프로그램에서 제거를 취소했습니다.'
    }
  }
  return {
    status: 'failed',
    rebootRequired: false,
    message: `제거 프로그램이 오류로 끝났습니다 (종료 코드 ${code}). 프로그램은 그대로일 수 있습니다.`
  }
}

export class UninstallService {
  readonly #d: UninstallServiceDeps
  readonly #confirmations: ConfirmationStore
  readonly #plans = new Map<string, StoredPlan>()
  #running = false

  constructor(deps: UninstallServiceDeps) {
    this.#d = deps
    this.#confirmations = deps.confirmations ?? new ConfirmationStore()
  }

  get running(): boolean {
    return this.#running
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  /** 제거 전 미리보기: 대상 확인 + 확인 토큰 발급. 아무것도 실행하지 않는다 */
  async plan(programId: string): Promise<UninstallPlan> {
    const found = await this.#d.programs.find(programId)
    if (!found)
      throw new AppError('NOT_FOUND', '프로그램을 찾을 수 없습니다. 목록을 새로 고치세요.')
    const { record, match } = found
    if (match.safety === 'protected') {
      throw new AppError(
        'SAFETY_DENIED',
        `${record.name}: 시스템/하드웨어에 필요한 항목이라 제거할 수 없습니다.`
      )
    }
    const command = this.#parse(record.uninstallCommand)
    const needsAck = match.safety === 'caution'
    const planId = (this.#d.newId ?? randomUUID)()
    const token = this.#confirmations.issue({ planId, digest: fingerprint(programId, command) })
    this.#plans.set(programId, { planId, digest: fingerprint(programId, command), needsAck })
    while (this.#plans.size > MAX_STORED) {
      const oldest = this.#plans.keys().next().value
      if (oldest === undefined) break
      this.#plans.delete(oldest)
    }
    const warnings: string[] = []
    if (needsAck && match.impact) warnings.push(match.impact)
    if (record.isSystemComponent)
      warnings.push('Windows나 다른 프로그램이 함께 설치한 구성요소일 수 있습니다.')
    const plan: UninstallPlan = {
      programId,
      name: record.name,
      safety: match.safety === 'safe' ? 'safe' : match.safety === 'caution' ? 'caution' : 'unknown',
      warnings,
      needsCautionAck: needsAck,
      installerKind: command.kind,
      installerName: command.installerName,
      confirmationId: token.confirmationId,
      expiresAt: new Date(token.expiresAt).toISOString()
    }
    if (record.publisher) plan.publisher = record.publisher
    if (record.version) plan.version = record.version
    if (record.estimatedSizeBytes !== undefined) plan.sizeBytes = record.estimatedSizeBytes
    return plan
  }

  #parse(command: string | undefined): ParsedUninstallCommand {
    const parsed = parseUninstallCommand(command, this.#d.env)
    if (parsed.ok) return parsed.value
    throw new AppError(
      'SAFETY_DENIED',
      COMMAND_MESSAGES[parsed.reason] ?? '안전하게 실행할 수 없는 형식의 제거 명령입니다.'
    )
  }

  /**
   * 확인 토큰을 소비하고 공식 제거 프로그램을 실행한다. 검증에 실패하면 예외이고 아무것도 실행하지 않는다.
   * 반환된 done 은 제거 프로그램이 끝나면 결과로 이행된다 (reject 되지 않는다).
   */
  async start(request: {
    programId: string
    confirmationId: string
    acknowledgeCaution: boolean
  }): Promise<{ done: Promise<UninstallResult> }> {
    if (this.#running)
      throw new AppError('BUSY', '이미 진행 중인 제거가 있습니다. 끝난 뒤에 시도하세요.')
    const stored = this.#plans.get(request.programId)
    if (!stored)
      throw new AppError('NOT_FOUND', '제거 미리보기를 찾을 수 없습니다. 다시 [제거]를 누르세요.')

    // 실행 직전에 레지스트리를 다시 읽어 지금 값을 검사한다 (계획 이후 바뀌었을 수 있다)
    const found = await this.#d.programs.find(request.programId, true)
    if (!found) throw new AppError('NOT_FOUND', '프로그램이 더 이상 목록에 없습니다.')
    const { record, match } = found
    if (match.safety === 'protected') {
      throw new AppError(
        'SAFETY_DENIED',
        `${record.name}: 시스템/하드웨어에 필요한 항목이라 제거할 수 없습니다.`
      )
    }
    const command = this.#parse(record.uninstallCommand)

    const consumed = this.#confirmations.consume({
      planId: stored.planId,
      confirmationId: request.confirmationId,
      digest: fingerprint(request.programId, command),
      // 이 허가증(permit)은 삭제 관문에서 쓸 수 없다: itemIds 는 규칙 ID 가 아니라 programId 이고, 여기서 다른 곳으로 넘기지 않는다
      mode: 'trash',
      itemIds: [request.programId],
      needsCautionAck: stored.needsAck,
      acknowledgeCaution: request.acknowledgeCaution
    })
    if (!consumed.ok) {
      await this.#tryLog({
        op: 'confirm',
        result: 'denied',
        reason: consumed.reason,
        detail: record.name
      })
      throw new AppError('SAFETY_DENIED', CONFIRM_MESSAGES[consumed.reason])
    }
    this.#plans.delete(request.programId)

    // 기록할 수 없으면 실행하지 않는다 (SAFETY.md §10)
    try {
      await this.#d.logger.write({
        op: 'uninstall',
        result: 'start',
        path: command.exe,
        ruleId: match.ruleId ?? undefined,
        detail: `${record.name} | ${command.args.join(' ')}`
      })
    } catch {
      throw new AppError('INTERNAL', '로그를 쓸 수 없어 제거를 시작하지 않았습니다.')
    }

    this.#running = true
    const done = this.#run(record.id, record.name, record.installLocation, command).finally(() => {
      this.#running = false
    })
    return { done }
  }

  async #run(
    programId: string,
    name: string,
    installLocation: string | undefined,
    command: ParsedUninstallCommand
  ): Promise<UninstallResult> {
    const startedAt = new Date(this.#now()).toISOString()
    let exitCode: number | undefined
    let interpreted: ReturnType<typeof interpretExitCode>

    let outcome = await this.#d.process.run(command.exe, command.args)
    if (outcome.kind === 'spawn-error' && ELEVATION_ERRORS.has(outcome.code) && this.#d.elevation) {
      // 관리자 권한이 필요한 제거 프로그램: Windows 권한 확인 창(UAC)으로 다시 실행한다
      const elevated = await this.#d.elevation.launch({ exe: command.exe, args: command.args })
      outcome =
        elevated.kind === 'exited'
          ? { kind: 'exited', code: elevated.code }
          : elevated.kind === 'declined'
            ? { kind: 'spawn-error', code: 'DECLINED', message: 'UAC 거부' }
            : { kind: 'spawn-error', code: 'ELEVATION_FAILED', message: elevated.detail }
    }

    if (outcome.kind === 'exited') {
      exitCode = outcome.code
      interpreted = interpretExitCode(outcome.code)
    } else if (outcome.code === 'DECLINED') {
      interpreted = {
        status: 'declined',
        rebootRequired: false,
        message: '관리자 권한을 허용하지 않아 제거를 시작하지 않았습니다.'
      }
    } else {
      interpreted = {
        status: 'failed',
        rebootRequired: false,
        message:
          outcome.code === 'ENOENT'
            ? '제거 프로그램 파일을 찾을 수 없어 실행하지 못했습니다.'
            : `제거 프로그램을 실행하지 못했습니다 (${outcome.code}).`
      }
    }

    // 목록을 다시 읽어 실제로 사라졌는지 확인한다 (제거 프로그램이 자신을 복사해 다시 실행하고 먼저 끝나는 경우가 있다)
    const stillListed: boolean | null = await this.#d.programs
      .load(true)
      .then((records) => records.some((r) => r.id === programId))
      .catch(() => null)
    let message = interpreted.message
    if (interpreted.status === 'finished' && stillListed === true) {
      message =
        '제거 프로그램이 끝났지만 목록에 아직 남아 있습니다. 다른 창에서 제거가 계속되고 있을 수 있으니 잠시 뒤 [새로 고침]을 눌러 보세요.'
    } else if (interpreted.status === 'finished' && stillListed === false) {
      message = interpreted.rebootRequired
        ? interpreted.message
        : '제거되었습니다. 목록에서 사라졌습니다.'
    }

    const result: UninstallResult = {
      programId,
      name,
      startedAt,
      finishedAt: new Date(this.#now()).toISOString(),
      status: interpreted.status,
      rebootRequired: interpreted.rebootRequired,
      stillListed,
      message
    }
    if (exitCode !== undefined) result.exitCode = exitCode

    // 남은 폴더 후보 (P1): 보여주기만 한다. 지우는 일은 하지 않는다
    if (stillListed === false && installLocation && this.#d.dirExists(installLocation)) {
      const located = this.#d.scan?.locate(installLocation) ?? null
      result.leftover = { path: installLocation }
      if (located) result.leftover.scanNode = { scanId: located.scanId, nodeId: located.nodeId }
    }

    await this.#tryLog({
      op: 'uninstall',
      result: interpreted.status === 'failed' ? 'error' : 'end',
      path: command.exe,
      reason: interpreted.status,
      detail: `${name} | exit=${exitCode ?? '-'} | stillListed=${String(stillListed)}`
    })
    return result
  }

  async #tryLog(entry: LogEntry): Promise<void> {
    try {
      await this.#d.logger.write(entry)
    } catch {
      // 실행 후의 기록 실패는 결과에 영향을 주지 않는다 (시작 기록은 이미 남았다)
    }
  }
}
