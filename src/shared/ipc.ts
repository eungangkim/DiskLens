// IPC 채널 이름과 payload 타입의 단일 정의 위치 (main / preload / renderer 공유)
import type { UninstallPlan, UninstallResult } from './uninstall.ts'
import type {
  CleanupItem,
  CleanupMode,
  CleanupPlan,
  CleanupPlanItem,
  CleanupProgress,
  CleanupRecord,
  CleanupResult
} from './cleanup'
import type {
  DriveInfo,
  InstalledProgram,
  NodeView,
  RuleMatch,
  ScanProgress,
  ScanSummary,
  SkippedItem,
  TypeSummary
} from './types'

export const IPC_CHANNELS = {
  ping: 'app:ping',
  securityInfo: 'app:securityInfo',
  getDriveInfo: 'app:getDriveInfo',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanGetChildren: 'scan:getChildren',
  scanGetTop: 'scan:getTop',
  scanFind: 'scan:find',
  rulesDescribe: 'rules:describe',
  scanGetAncestors: 'scan:getAncestors',
  programsList: 'programs:list',
  programsOpenFolder: 'programs:openFolder',
  programsUninstallPlan: 'programs:uninstallPlan',
  programsUninstall: 'programs:uninstall',
  programsUninstallDone: 'programs:uninstallDone',
  cleanupItems: 'cleanup:items',
  cleanupAnalyze: 'cleanup:analyze',
  cleanupPlan: 'cleanup:plan',
  cleanupExecute: 'cleanup:execute',
  cleanupCancel: 'cleanup:cancel',
  cleanupHistory: 'cleanup:history',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsPickFolder: 'settings:pickFolder',
  appInfo: 'app:info',
  appOpenFolder: 'app:openFolder',
  appReloadRules: 'app:reloadRules',
  scanGetTypeSummary: 'scan:getTypeSummary',
  scanGetSkipped: 'scan:getSkipped',
  scanLoadCache: 'scan:loadCache',
  /** main → renderer 이벤트 */
  scanProgress: 'scan:progress',
  scanDone: 'scan:done',
  scanError: 'scan:error',
  cleanupProgress: 'cleanup:progress',
  cleanupDone: 'cleanup:done',
  showInExplorer: 'shell:showInExplorer',
  copyPath: 'shell:copyPath'
} as const

// --- 공통 응답 형식 (ARCHITECTURE.md §6) ---
export type IpcErrorCode =
  'SAFETY_DENIED' | 'NOT_FOUND' | 'PERMISSION' | 'INVALID_REQUEST' | 'BUSY' | 'INTERNAL'

export type IpcResult<T> =
  { ok: true; data: T } | { ok: false; code: IpcErrorCode; message: string }

// --- 앱 기본 ---
export interface PingRequest {
  message: string
}

export interface PingResponse {
  ok: true
  echo: string
  at: string
}

/** 보안 설정 확인용. main이 실제 webPreferences 값을 보고한다. */
export interface SecurityInfo {
  contextIsolation: boolean
  nodeIntegration: boolean
  sandbox: boolean
}

// --- 스캔 ---
export interface ScanStartResponse {
  scanId: string
  root: string
}

export type ScanSort = 'size' | 'name' | 'files'

export interface GetChildrenRequest {
  scanId: string
  nodeId: string
  sort: ScanSort
  limit: number
  offset: number
}

export interface GetTopRequest {
  scanId: string
  kind: 'folders' | 'files'
  limit: number
}

export type SafetyFilter = 'all' | 'safe' | 'caution' | 'protected' | 'unknown'

/** 안전도 필터 / "지워도 되는 것만" / 이름 검색 (결과는 큰 순 평면 목록) */
export interface FindRequest {
  scanId: string
  safety: SafetyFilter
  cleanableOnly: boolean
  query: string
  limit: number
}

export interface DescribeRequest {
  scanId: string
  nodeIds: string[]
}

export interface ProgramsListRequest {
  includeSystem: boolean
  /** true 면 레지스트리를 다시 읽는다 (아니면 앱 시작 후 읽어 둔 목록) */
  refresh: boolean
}

export interface ProgramIdRequest {
  programId: string
}

/** 제거 실행: 경로나 명령이 아니라 programId 와 확인 토큰만 보낸다 */
export interface UninstallRequest {
  programId: string
  confirmationId: string
  acknowledgeCaution: boolean
}

export interface CleanupAnalyzeRequest {
  itemId: string
}

export interface CleanupPlanRequest {
  itemIds: string[]
  mode: CleanupMode
}

export interface CleanupExecuteRequest {
  planId: string
  confirmationId: string
  acknowledgeCaution: boolean
}

export interface CleanupCancelRequest {
  jobId: string
}

export type ThemeSetting = 'system' | 'light' | 'dark'
export type SizeUnitSetting = 'GiB' | 'GB'

/** 앱 설정 (DATA_SPEC §4 settings.json). 모든 값은 main 이 다시 검증한다 */
export interface AppSettings {
  /** 임시·캐시 항목에 한해 영구 삭제 허용 (기본 false) */
  allowPermanentDelete: boolean
  /** 용량 표시 단위: GiB(1024 기준) / GB(1000 기준) */
  sizeUnit: SizeUnitSetting
  theme: ThemeSetting
  /** 스캔 루트. null 이면 기본(C:\). 폴더 선택 대화상자로만 고른다 */
  scanRoot: string | null
  /** 스캔에서 제외할 폴더 (스캔에만 영향 — 삭제 안전 검사와는 무관) */
  excludePaths: string[]
}

export interface AppInfo {
  version: string
  rulesVersion: string
  ruleCounts: { builtin: number; user: number }
  /** 거부된 규칙 수 (자세한 사유는 로그) */
  ruleIssues: number
  userRulesPath: string
  userRulesExists: boolean
  logDir: string
  userDataDir: string
}

export type OpenFolderTarget = 'logs' | 'userData'
export interface OpenFolderRequest {
  target: OpenFolderTarget
}
export interface PickFolderRequest {
  purpose: 'scanRoot' | 'exclude'
}

export interface ScanIdRequest {
  scanId: string
}

export interface SkippedResponse {
  total: number
  items: SkippedItem[]
}

export interface NodeIdRequest {
  scanId: string
  nodeId: string
}

/** 캐시 로드 결과: 요약 + 스캔 루트 */
export interface CachedScan {
  summary: ScanSummary
}

/** preload가 window.api 로 노출하는 API 형태 */
export interface DiskLensApi {
  ping: (req: PingRequest) => Promise<PingResponse>
  getSecurityInfo: () => Promise<SecurityInfo>
  getDriveInfo: () => Promise<IpcResult<DriveInfo>>
  scan: {
    start: () => Promise<IpcResult<ScanStartResponse>>
    cancel: (req: ScanIdRequest) => Promise<IpcResult<null>>
    getChildren: (req: GetChildrenRequest) => Promise<IpcResult<NodeView[]>>
    getTop: (req: GetTopRequest) => Promise<IpcResult<NodeView[]>>
    find: (req: FindRequest) => Promise<IpcResult<NodeView[]>>
    /** 루트부터 해당 노드까지의 폴더 ID (트리에서 위치 찾기용) */
    getAncestors: (req: NodeIdRequest) => Promise<IpcResult<string[]>>
    getTypeSummary: (req: ScanIdRequest) => Promise<IpcResult<TypeSummary[]>>
    getSkipped: (req: ScanIdRequest) => Promise<IpcResult<SkippedResponse>>
    loadCache: () => Promise<IpcResult<CachedScan | null>>
    /** 구독 함수. 반환값을 호출하면 구독이 해제된다. */
    onProgress: (callback: (progress: ScanProgress) => void) => () => void
    onDone: (callback: (summary: ScanSummary) => void) => () => void
    onError: (callback: (message: string) => void) => () => void
  }
  rules: {
    describe: (req: DescribeRequest) => Promise<IpcResult<RuleMatch[]>>
  }
  programs: {
    list: (req: ProgramsListRequest) => Promise<IpcResult<InstalledProgram[]>>
    openFolder: (req: ProgramIdRequest) => Promise<IpcResult<null>>
    /** 제거 미리보기 + 확인 토큰 발급 (실행하지 않는다) */
    uninstallPlan: (req: ProgramIdRequest) => Promise<IpcResult<UninstallPlan>>
    /** 확인 토큰으로 공식 제거 프로그램 실행 시작. 끝나면 이벤트로 결과를 받는다 */
    uninstall: (req: UninstallRequest) => Promise<IpcResult<{ started: true }>>
    onUninstallDone: (callback: (result: UninstallResult) => void) => () => void
  }
  cleanup: {
    items: () => Promise<IpcResult<CleanupItem[]>>
    /** 항목 하나의 대상 수/용량 계산 (삭제 없음) */
    analyze: (req: CleanupAnalyzeRequest) => Promise<IpcResult<CleanupPlanItem>>
    /** 미리보기 + 확인 토큰 발급 (삭제 없음) */
    plan: (req: CleanupPlanRequest) => Promise<IpcResult<CleanupPlan>>
    /** 확인 토큰으로 실행 시작. 진행/완료는 이벤트로 받는다 */
    execute: (req: CleanupExecuteRequest) => Promise<IpcResult<{ jobId: string }>>
    cancel: (req: CleanupCancelRequest) => Promise<IpcResult<{ cancelled: boolean }>>
    history: () => Promise<IpcResult<CleanupRecord[]>>
    onProgress: (callback: (progress: CleanupProgress) => void) => () => void
    onDone: (callback: (result: CleanupResult) => void) => () => void
  }
  settings: {
    get: () => Promise<IpcResult<AppSettings>>
    set: (req: AppSettings) => Promise<IpcResult<AppSettings>>
    /** 폴더 선택 대화상자를 main 이 띄운다. 취소하면 null */
    pickFolder: (req: PickFolderRequest) => Promise<IpcResult<string | null>>
  }
  app: {
    info: () => Promise<IpcResult<AppInfo>>
    /** 로그/사용자 데이터 폴더를 탐색기에서 연다 (경로는 main 이 정한다) */
    openFolder: (req: OpenFolderRequest) => Promise<IpcResult<null>>
    /** 사용자 규칙을 다시 읽기 위해 앱을 다시 시작한다 */
    reloadRules: () => Promise<IpcResult<null>>
  }
  shell: {
    showInExplorer: (req: NodeIdRequest) => Promise<IpcResult<null>>
    copyPath: (req: NodeIdRequest) => Promise<IpcResult<null>>
  }
}
