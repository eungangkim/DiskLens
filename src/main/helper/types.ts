// 관리자 정리 포트 (main ↔ 헬퍼). 정리 서비스는 이 인터페이스만 안다: 실제 UAC 실행은 adminClient 가 한다.
import type { CleanupItemResult, CleanupMode } from '../../shared/cleanup.ts'

export interface AdminRunRequest {
  jobId: string
  /** 규칙 ID 만. 경로는 보내지 않는다 */
  itemIds: string[]
  mode: CleanupMode
  acknowledgeCaution: boolean
}

export type AdminRunOutcome =
  /** 사용자가 UAC 창에서 거부함 */
  | { kind: 'declined' }
  /** 실행 실패, 헬퍼가 job 을 거부함, 결과 파일을 읽지 못함 등 */
  | { kind: 'failed'; detail: string }
  | { kind: 'done'; perItem: CleanupItemResult[]; cancelled: boolean }

export interface AdminCleanupPort {
  run(request: AdminRunRequest): Promise<AdminRunOutcome>
  /** 진행 중인 헬퍼 작업에 취소를 알린다 (최선 노력: 헬퍼가 파일 사이에서 확인한다) */
  requestCancel(jobId: string): void
}
