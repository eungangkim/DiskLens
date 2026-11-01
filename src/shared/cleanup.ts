// 정리(Cleanup) 공용 타입 (DATA_SPEC.md §3.5). 6단계에서는 main 모듈과 테스트만 쓰고, IPC/UI 연결은 7단계다.

export type CleanupMode = 'trash' | 'permanent'

/** 삭제 관문이 요청을 거부한 이유 (TEST_PLAN.md §4.4 의 "이유 코드") */
export type DenyReason =
  | 'no-confirmation' // 확인 토큰(ExecutionPermit)이 없거나 위조/이 항목·모드를 허용하지 않음
  | 'invalid-path' // 빈 문자열, 널 문자, 너무 긴 경로, 절대 경로 아님, UNC/장치 경로, 스트림 표기
  | 'protected-path' // 하드코딩 보호 경로 (SAFETY.md §3)
  | 'protected-rule' // 보호(protected) 규칙이 가리키는 곳
  | 'unknown-rule' // 규칙이 없는 곳
  | 'outside-scope' // 이 정리 항목의 규칙 범위 밖 (다른 규칙의 영역)
  | 'not-cleanable' // 표시 전용 규칙(cleanable: false)
  | 'special-action-only' // 휴지통 비우기/디스크 정리처럼 전용 동작으로만 처리하는 항목
  | 'caution-not-acknowledged' // caution 인데 경고 확인 플래그 없음
  | 'permanent-not-allowed' // 영구 삭제인데 규칙/카테고리가 허용하지 않음
  | 'permanent-disabled' // 영구 삭제인데 설정에서 꺼져 있음
  | 'self-not-allowed' // 규칙 루트 폴더 자체를 지우려 함 (contents 모드) 또는 루트가 아닌 곳을 self 로 지우려 함
  | 'link' // 심볼릭 링크/정션(링크는 따라가지도, 지우지도 않는다)
  | 'not-found' // 대상이 없음 (거부가 아니라 건너뜀)

/** 건너뜀 이유 (DATA_SPEC.md §3.5 + 링크) */
export type SkipReason =
  | 'in-use'
  | 'permission-denied'
  | 'safety-denied'
  | 'not-found'
  | 'admin-declined'
  | 'link'
  | 'other'

export interface CleanupItem {
  itemId: string
  name: string
  group: string
  description: string
  impact: string
  safety: 'safe' | 'caution'
  estimatedBytes: number | null
  fileCount: number | null
  requiresAdmin: boolean
  allowPermanent: boolean
  defaultSelected: boolean
  needsProcessClosed?: string[]
  specialAction?: 'empty-recycle-bin' | 'run-disk-cleanup'
}

export interface CleanupPlanItem {
  itemId: string
  fileCount: number
  bytes: number
  /** 대표 경로 3개 (가장 큰 것) */
  sample: string[]
  /** caution 문구, 제외된 항목 수, 프로세스 실행 중 경고 등 */
  warnings: string[]
}

export interface CleanupPlan {
  planId: string
  mode: CleanupMode
  items: CleanupPlanItem[]
  totalFiles: number
  totalBytes: number
  requiresAdmin: boolean
  needsCautionAck: boolean
  /** 일회용·짧은 TTL·이 계획 내용에 묶인 확인 토큰 */
  confirmationId: string
  expiresAt: string
}

export interface CleanupProgress {
  jobId: string
  itemId: string
  processedFiles: number
  freedBytes: number
  currentPath?: string
}

export interface CleanupItemResult {
  itemId: string
  freedBytes: number
  deletedFiles: number
  skipped: Array<{ reason: SkipReason; count: number }>
}

export interface CleanupResult {
  jobId: string
  startedAt: string
  finishedAt: string
  mode: CleanupMode
  freedBytes: number
  deletedFiles: number
  skippedFiles: number
  cancelled: boolean
  perItem: CleanupItemResult[]
  /** 로그를 쓸 수 없어 중단되는 등 작업 전체에 영향을 준 오류 */
  error?: string
}

export interface CleanupRecord {
  jobId: string
  at: string
  mode: CleanupMode
  freedBytes: number
  itemIds: string[]
  /** 아래는 10단계에서 추가 (이전 기록에는 없다) */
  deletedFiles?: number
  skippedFiles?: number
  cancelled?: boolean
  perItem?: CleanupItemResult[]
}
