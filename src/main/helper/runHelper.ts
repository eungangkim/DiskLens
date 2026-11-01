// 관리자 헬퍼 본체 (상승된 프로세스에서 실행). Electron 에 의존하지 않아 테스트에서 샌드박스로 그대로 돌려 볼 수 있다.
// 입력은 job 파일 하나뿐이고, 거기에는 규칙 ID 만 있다. 지울 경로는 헬퍼가 하드코딩 허용 목록(adminRules.ts)에서 직접 만든다.
// main 이 "허용했다"는 말은 믿지 않는다: 서명·허용 목록·보호 경로 검사(DeleteGuard)·대상 재확인을 헬퍼가 다시 한다.
import { readFileSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CleanupMode } from '../../shared/cleanup.ts'
import { createCleanupEngine } from '../cleaner/engine.ts'
import { createMemoryHistory } from '../cleaner/history.ts'
import { buildRuleSet } from '../rules/loader.ts'
import type { RuleEnv } from '../rules/paths.ts'
import { loadSettings } from '../settings.ts'
import { adminPathRules } from './adminRules.ts'
import {
  CANCEL_FILE,
  ELEVATED_DIR_NAME,
  JOB_FILE,
  RESULT_FILE,
  RESULT_SCHEMA_VERSION,
  writeJsonAtomic,
  type HelperResult
} from './jobFiles.ts'
import { MAX_JOB_BYTES, verifyJob, type JobRejectReason } from './job.ts'

/** 종료 코드: 0 정상, 2 job 거부, 3 헬퍼 내부 오류, 4 정리 실행 거부/실패 */
export type HelperExitCode = 0 | 2 | 3 | 4

export interface RunHelperOptions {
  jobFile: string
  /** 실행 인자로 받은 job 토큰 (서명 키) */
  token: string
  /** 이미 검증된 환경변수 (helper/env.ts 의 verifyHelperEnv 결과, 또는 테스트의 가짜 드라이브 env) */
  env: RuleEnv
  appPaths: readonly string[]
  trash: (path: string) => Promise<void>
  now?: () => number
}

export interface HelperOutcome {
  exitCode: HelperExitCode
  reason?: JobRejectReason | 'bad-location' | 'bad-rules' | 'plan-failed' | 'internal'
  message?: string
}

const failure = (
  jobId: string,
  reason: string,
  error: string
): Extract<HelperResult, { ok: false }> => ({
  schemaVersion: RESULT_SCHEMA_VERSION,
  jobId,
  ok: false,
  reason,
  error
})

async function readJobText(jobFile: string): Promise<string | JobRejectReason> {
  let info
  try {
    info = await lstat(jobFile)
  } catch {
    return 'unreadable'
  }
  // 링크로 바꿔치기한 job 은 읽지 않는다
  if (!info.isFile() || info.isSymbolicLink()) return 'not-regular-file'
  if (info.size > MAX_JOB_BYTES) return 'too-large'
  try {
    return await readFile(jobFile, 'utf8')
  } catch {
    return 'unreadable'
  }
}

function cancelRequested(dir: string, jobId: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(dir, CANCEL_FILE), 'utf8')) as { jobId?: unknown }
    return data.jobId === jobId
  } catch {
    return false
  }
}

export async function runHelper(options: RunHelperOptions): Promise<HelperOutcome> {
  const now = options.now ?? Date.now
  const dir = dirname(options.jobFile)

  // job 파일은 <userData>/elevated/job.json 이어야 한다 (결과·취소 파일도 같은 폴더의 고정 이름)
  if (basename(options.jobFile) !== JOB_FILE || basename(dir) !== ELEVATED_DIR_NAME) {
    return { exitCode: 2, reason: 'bad-location', message: 'job 파일 위치가 올바르지 않습니다.' }
  }
  const reject = async (reason: JobRejectReason, jobId = ''): Promise<HelperOutcome> => {
    try {
      await writeJsonAtomic(
        dir,
        RESULT_FILE,
        failure(jobId, reason, `job 을 거부했습니다: ${reason}`)
      )
    } catch {
      // 결과를 못 써도 종료 코드로 알린다
    }
    return { exitCode: 2, reason, message: `job 거부: ${reason}` }
  }

  const text = await readJobText(options.jobFile)
  if (text === 'unreadable' || text === 'too-large' || text === 'not-regular-file') {
    return reject(text)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return reject('malformed')
  }
  const checked = verifyJob(raw, options.token, now())
  if (!checked.ok) {
    const id = (raw as { jobId?: unknown } | null)?.jobId
    return reject(checked.reason, typeof id === 'string' ? id : '')
  }
  const { job } = checked

  const writeResult = async (result: HelperResult): Promise<void> => {
    await writeJsonAtomic(dir, RESULT_FILE, result)
  }

  try {
    const userDataDir = dirname(dir)
    // 허용 목록 → 규칙. 사용자 규칙 파일은 읽지 않는다 (사용자가 쓸 수 있는 파일을 상승 상태에서 믿지 않는다)
    const rules = buildRuleSet(
      {
        builtin: {
          schemaVersion: 1,
          rulesVersion: 'helper',
          pathRules: adminPathRules(),
          programRules: []
        }
      },
      { env: options.env, appPaths: options.appPaths }
    )
    if (rules.issues.length > 0 || rules.matcher.rules.length === 0) {
      await writeResult(failure(job.jobId, 'bad-rules', '헬퍼 규칙을 만들 수 없습니다.'))
      return { exitCode: 3, reason: 'bad-rules', message: JSON.stringify(rules.issues) }
    }

    // 영구 삭제 허용 여부는 job 이 아니라 설정 파일에서 직접 읽는다 (job 을 믿지 않는다)
    const settings = await loadSettings(join(userDataDir, 'settings.json'))
    let service: ReturnType<typeof createCleanupEngine>['service'] | null = null
    let seq = 0
    const engine = createCleanupEngine({
      matcher: rules.matcher,
      protectedContext: { env: options.env, appPaths: options.appPaths },
      userDataDir,
      settings: { allowPermanentDelete: () => settings.get().allowPermanentDelete },
      trash: options.trash,
      isElevatedHelper: true,
      history: createMemoryHistory(), // 기록은 main 이 남긴다
      newId: () => `${job.jobId}-helper${++seq}`,
      onProgress: () => {
        if (service && cancelRequested(dir, job.jobId)) service.cancel()
      }
    })
    service = engine.service

    const mode: CleanupMode = job.mode
    let plan
    try {
      plan = await engine.service.plan(job.itemIds, mode)
    } catch (error) {
      const message = error instanceof Error ? error.message : '계획을 만들지 못했습니다.'
      await writeResult(failure(job.jobId, 'plan-failed', message))
      return { exitCode: 4, reason: 'plan-failed', message }
    }
    const done = await engine.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: job.acknowledgeCaution
    })
    await writeResult({
      schemaVersion: RESULT_SCHEMA_VERSION,
      jobId: job.jobId,
      ok: true,
      cancelled: done.cancelled,
      ...(done.error !== undefined ? { error: done.error } : {}),
      perItem: done.perItem
    })
    return { exitCode: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : '헬퍼 오류'
    try {
      await writeResult(failure(job.jobId, 'internal', message))
    } catch {
      // 종료 코드로 알린다
    }
    return { exitCode: 3, reason: 'internal', message }
  }
}
