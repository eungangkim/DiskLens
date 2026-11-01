// 공용 데이터 타입 (DATA_SPEC.md §3 기준). main / worker / CLI / renderer 가 공유한다.
// 스캔 엔진 코드는 Node의 타입 제거(type stripping)로도 실행되므로 enum 등 변환이 필요한 문법을 쓰지 않는다.
import type { UninstallBlock } from './uninstall.ts'

export type NodeId = string

export interface ScanOptions {
  /** 스캔에서 제외할 폴더(정확한 경로, 대소문자 무시) */
  excludePaths: string[]
  /** 디스크 점유 크기(클러스터 올림) 기준으로 계산할지 */
  allocatedSize: boolean
  /** 클러스터 크기(바이트). 기본 4096 */
  clusterSize: number
  /** 상위 큰 파일 보관 개수. 기본 500 */
  topFilesK: number
  /** 이 크기 미만의 폴더는 "기타 N개"로 접는다. 기본 1MB */
  collapseThresholdBytes: number
  /** 접지 않을 폴더의 전체 경로(규칙 경로). 그 상위 폴더도 함께 유지된다 */
  keepPaths: string[]
  /** 접지 않을 폴더 이름(예: node_modules). 대소문자 무시 */
  keepNames: string[]
  /** 동시에 처리할 폴더 수 */
  concurrency: number
  /** 건너뜀 목록에 보관할 최대 샘플 수 */
  skippedSampleMax: number
}

export interface ScanProgress {
  scanId: string
  filesScanned: number
  dirsScanned: number
  bytesScanned: number
  skippedCount: number
  currentPath: string
  elapsedMs: number
}

export interface ScanSummary {
  scanId: string
  root: string
  startedAt: string
  finishedAt: string
  totalBytes: number
  totalFiles: number
  totalDirs: number
  skippedCount: number
  cancelled: boolean
  allocatedSize: boolean
  rootNodeId: NodeId
  driveInfo?: { totalBytes: number; freeBytes: number }
}

export interface FolderNode {
  id: NodeId
  parentId: NodeId | null
  name: string
  path: string
  /** 하위 전체 합 */
  size: number
  /** 이 폴더 직계 파일 합 */
  ownFilesSize: number
  ownFileCount: number
  /** 하위 전체 파일 수 */
  fileCount: number
  dirCount: number
  /** 접힌(collapsed) 폴더는 포함되지 않음. 용량 내림차순 */
  childIds: NodeId[]
  /** "기타 N개 폴더" 합계 */
  collapsed?: { count: number; size: number }
  isLink?: boolean
  cloudOnly?: boolean
  skippedChildren?: number
  /** 접근 불가 등으로 불완전 */
  truncated?: boolean
}

export interface TopFileEntry {
  path: string
  size: number
  modifiedAt: string
  ext: string
}

export type FileType =
  | 'video'
  | 'image'
  | 'audio'
  | 'archive'
  | 'executable'
  | 'document'
  | 'code'
  | 'disk-image'
  | 'other'

export interface TypeSummary {
  type: FileType
  bytes: number
  fileCount: number
}

export type SkipReason = 'permission-denied' | 'busy' | 'not-found' | 'other'

export interface SkippedItem {
  path: string
  reason: SkipReason
}

/** 스캔 한 번의 전체 결과 (캐시 파일의 내용과 같다) */
export interface ScanResult {
  summary: ScanSummary
  nodes: FolderNode[]
  topFiles: TopFileEntry[]
  typeSummary: TypeSummary[]
  skippedSample: SkippedItem[]
}

export function defaultScanOptions(): ScanOptions {
  return {
    excludePaths: [],
    allocatedSize: true,
    clusterSize: 4096,
    topFilesK: 500,
    collapseThresholdBytes: 1024 * 1024,
    keepPaths: [],
    keepNames: [],
    concurrency: 16,
    skippedSampleMax: 1000
  }
}

// --- UI 전달용 뷰 모델 (DATA_SPEC.md §3.3) ---

/** 규칙 매칭 결과. 4단계 전까지는 항상 규칙 없음(unknown)이다. */
export interface RuleMatch {
  ruleId: string | null
  source?: 'builtin' | 'user'
  name?: string
  safety: 'safe' | 'caution' | 'protected' | 'unknown'
  category?: string
  description?: string
  impact?: string
  cleanable: boolean
  /** UI의 삭제 버튼 활성 여부의 근거. 3단계에서는 항상 false */
  canDelete: boolean
}

export interface NodeView {
  /** 폴더는 노드 ID. 합성 행은 `col:<부모ID>`(기타 폴더), `own:<부모ID>`(직계 파일), 큰 파일은 `f:<번호>` */
  id: string
  kind: 'folder' | 'file' | 'collapsed'
  name: string
  path: string
  size: number
  percentOfParent: number
  percentOfTotal: number
  fileCount?: number
  hasChildren: boolean
  isLink?: boolean
  cloudOnly?: boolean
  /** 큰 파일 목록에서만 */
  modifiedAt?: string
  ext?: string
  match: RuleMatch
}

export interface DriveInfo {
  root: string
  totalBytes: number
  freeBytes: number
}

export const UNKNOWN_MATCH: RuleMatch = {
  ruleId: null,
  safety: 'unknown',
  cleanable: false,
  canDelete: false
}

// --- 설치 프로그램 (DATA_SPEC.md §3.4) ---
export type ProgramScope = 'machine' | 'machine-x86' | 'user'

/**
 * UI 전달용 설치 프로그램. 제거 명령(UninstallString)은 main 안에만 두고 UI로 보내지 않는다.
 * (9단계에서 main 이 programId 로 다시 찾아 실행한다)
 */
export interface InstalledProgram {
  /** 레지스트리 키 이름 + hive 해시 */
  id: string
  name: string
  publisher?: string
  version?: string
  /** YYYY-MM-DD. 레지스트리 값을 해석할 수 없으면 없음 */
  installDate?: string
  installLocation?: string
  estimatedSizeBytes?: number
  sizeSource: 'registry' | 'scan' | 'unknown'
  isSystemComponent: boolean
  scope: ProgramScope
  match: RuleMatch
  /** 제거 버튼을 쓸 수 있는지 (protected 가 아니고, 안전하게 실행할 수 있는 UninstallString 이 있음) */
  canUninstall: boolean
  /** 쓸 수 없다면 이유 */
  uninstallBlock?: UninstallBlock
  /** 설치 폴더가 현재 스캔 결과에 있으면 그 노드 (스캔 탭에서 보기용) */
  scanNode?: { scanId: string; nodeId: string }
}
