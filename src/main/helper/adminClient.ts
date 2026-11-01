// main 쪽 관리자 클라이언트: job 파일을 만들고, UAC 로 헬퍼를 띄우고, 결과 파일을 검증해서 돌려준다.
// 보내는 것은 규칙 ID·모드·서명뿐이다. 헬퍼가 지울 경로는 헬퍼가 자기 허용 목록에서 만든다.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ElevationPort } from './elevation.ts'
import { isAdminItemId } from './adminRules.ts'
import { createJob } from './job.ts'
import {
  CANCEL_FILE,
  JOB_FILE,
  RESULT_FILE,
  helperResultSchema,
  readJsonIfExists,
  writeJsonAtomic
} from './jobFiles.ts'
import type { AdminCleanupPort, AdminRunOutcome, AdminRunRequest } from './types.ts'

export interface AdminClientOptions {
  /** <userData>/elevated */
  dir: string
  elevation: ElevationPort
  /** 상승 실행할 프로그램. 패키징: 앱 exe + [], 개발: electron.exe + [앱 경로] */
  launcher: { exe: string; baseArgs: readonly string[] }
  now?: () => number
  newToken?: () => string
}

export function createAdminClient(options: AdminClientOptions): AdminCleanupPort {
  const now = options.now ?? Date.now
  const newToken = options.newToken ?? ((): string => randomBytes(32).toString('hex'))

  return {
    async run(request: AdminRunRequest): Promise<AdminRunOutcome> {
      // 허용 목록 밖의 항목은 아예 보내지 않는다 (헬퍼도 다시 거부한다)
      if (request.itemIds.length === 0 || !request.itemIds.every(isAdminItemId)) {
        return { kind: 'failed', detail: '관리자 헬퍼가 지원하지 않는 항목이 있습니다.' }
      }
      const token = newToken()
      const job = createJob({
        jobId: request.jobId,
        itemIds: request.itemIds,
        mode: request.mode,
        acknowledgeCaution: request.acknowledgeCaution,
        token,
        now: now()
      })
      try {
        await writeJsonAtomic(options.dir, JOB_FILE, job)
      } catch (error) {
        return {
          kind: 'failed',
          detail: `job 파일을 만들지 못했습니다: ${error instanceof Error ? error.message : ''}`
        }
      }

      const outcome = await options.elevation.launch({
        exe: options.launcher.exe,
        args: [
          ...options.launcher.baseArgs,
          '--cleanup-helper',
          '--job',
          join(options.dir, JOB_FILE),
          '--token',
          token
        ]
      })
      if (outcome.kind === 'declined') return { kind: 'declined' }
      if (outcome.kind === 'failed') return { kind: 'failed', detail: outcome.detail }

      // 결과 파일도 믿지 않는다: 구조와 jobId 를 검사한다 (이전 실행의 파일이면 무시)
      const parsed = helperResultSchema.safeParse(
        await readJsonIfExists(join(options.dir, RESULT_FILE))
      )
      if (!parsed.success || parsed.data.jobId !== request.jobId) {
        return {
          kind: 'failed',
          detail: `헬퍼 결과를 확인하지 못했습니다 (종료 코드 ${outcome.code}).`
        }
      }
      if (!parsed.data.ok) {
        return { kind: 'failed', detail: `${parsed.data.reason}: ${parsed.data.error}` }
      }
      return { kind: 'done', perItem: parsed.data.perItem, cancelled: parsed.data.cancelled }
    },

    requestCancel(jobId) {
      void writeJsonAtomic(options.dir, CANCEL_FILE, { jobId }).catch(() => undefined)
    }
  }
}
