// 스캔 서비스: ScanEngine 실행, 결과 보관, 캐시 저장/로드, 조회 API.
// IPC 핸들러는 얇게 유지하고 로직은 여기에 둔다 (ARCHITECTURE.md §4.1).
import type { ScanProgress, ScanResult, ScanSummary } from '../../shared/types.ts'
import type {
  DescribeRequest,
  FindRequest,
  GetChildrenRequest,
  GetTopRequest,
  SkippedResponse
} from '../../shared/ipc.ts'
import type { NodeView, RuleMatch, ScanOptions, TypeSummary } from '../../shared/types.ts'
import { NO_RULES, type RuleLookup } from '../rules/matcher.ts'
import { loadLatestScanCache, saveScanCache } from './cache.ts'
import type { ScanEngine } from './manager.ts'
import {
  buildIndex,
  ancestorIds,
  describeNodes,
  findNodeByPath,
  findNodes,
  getChildren,
  getTopFiles,
  getTopFolders,
  resolvePath,
  type ScanIndex
} from './view.ts'
import { AppError } from '../ipc/errors.ts'

export interface ScanServiceEvents {
  onProgress: (progress: ScanProgress) => void
  onDone: (summary: ScanSummary) => void
  onError: (message: string) => void
}

export interface ScanServiceOptions {
  engine: ScanEngine
  cacheDir: string
  /** 고정 문자열 또는 매 스캔마다 읽는 함수 (설정에서 바뀔 수 있다) */
  root: string | (() => string)
  /** 스캔에서 제외할 폴더 (설정) */
  excludePaths?: () => string[]
  events: ScanServiceEvents
  log?: (message: string, error?: unknown) => void
  /** 규칙 매처. 없으면 모든 항목이 unknown */
  rules?: RuleLookup
  /** 스캔 시 규칙이 가리키는 폴더를 접지 않게 하는 힌트 (keepPaths/keepNames) */
  scanHints?: ScanHints | (() => ScanHints)
}

export type ScanHints = Partial<Pick<ScanOptions, 'keepPaths' | 'keepNames'>>

export class ScanService {
  #engine: ScanEngine
  #cacheDir: string
  #root: string | (() => string)
  #exclude: () => string[]
  #events: ScanServiceEvents
  #log: (message: string, error?: unknown) => void
  #rules: RuleLookup
  #hints: ScanHints | (() => ScanHints)
  #current: ScanIndex | null = null
  #runningId: string | null = null

  constructor(options: ScanServiceOptions) {
    this.#engine = options.engine
    this.#cacheDir = options.cacheDir
    this.#root = options.root
    this.#exclude = options.excludePaths ?? (() => [])
    this.#events = options.events
    this.#log = options.log ?? (() => undefined)
    this.#rules = options.rules ?? NO_RULES
    this.#hints = options.scanHints ?? {}
    this.#engine.onProgress((p) => this.#events.onProgress(p))
  }

  get root(): string {
    return typeof this.#root === 'function' ? this.#root() : this.#root
  }

  start(): { scanId: string; root: string } {
    if (this.#runningId) throw new AppError('BUSY', '이미 스캔이 진행 중입니다.')
    const root = this.root
    const hints = typeof this.#hints === 'function' ? this.#hints() : this.#hints
    const handle = this.#engine.start(root, { ...hints, excludePaths: this.#exclude() })
    this.#runningId = handle.scanId
    handle.result.then(
      async (result) => {
        this.#runningId = null
        await this.#adopt(result)
        this.#events.onDone(result.summary)
      },
      (error: unknown) => {
        this.#runningId = null
        this.#events.onError(error instanceof Error ? error.message : String(error))
      }
    )
    return { scanId: handle.scanId, root }
  }

  cancel(scanId: string): void {
    if (this.#runningId !== scanId) throw new AppError('NOT_FOUND', '진행 중인 스캔이 아닙니다.')
    this.#engine.cancel()
  }

  /** 취소된 부분 결과는 보관/캐시하지 않고 이전 결과를 그대로 둔다 */
  async #adopt(result: ScanResult): Promise<void> {
    if (result.summary.cancelled) return
    this.#current = buildIndex(result, this.#rules)
    try {
      await saveScanCache(this.#cacheDir, result)
    } catch (error) {
      this.#log('스캔 캐시 저장 실패', error) // 캐시 실패는 스캔 결과 표시를 막지 않는다
    }
  }

  async loadCache(): Promise<ScanSummary | null> {
    const cached = await loadLatestScanCache(this.#cacheDir)
    if (!cached) return null
    this.#current = buildIndex(cached, this.#rules)
    return cached.summary
  }

  #index(scanId: string): ScanIndex {
    if (!this.#current || this.#current.result.summary.scanId !== scanId) {
      throw new AppError('NOT_FOUND', '해당 스캔 결과를 찾을 수 없습니다. 다시 스캔해 주세요.')
    }
    return this.#current
  }

  getChildren(req: GetChildrenRequest): NodeView[] {
    const views = getChildren(this.#index(req.scanId), req.nodeId, req.sort, req.limit, req.offset)
    if (!views) throw new AppError('NOT_FOUND', '폴더를 찾을 수 없습니다.')
    return views
  }

  getTop(req: GetTopRequest): NodeView[] {
    const index = this.#index(req.scanId)
    return req.kind === 'files' ? getTopFiles(index, req.limit) : getTopFolders(index, req.limit)
  }

  find(req: FindRequest): NodeView[] {
    const { scanId, ...rest } = req
    return findNodes(this.#index(scanId), rest)
  }

  describe(req: DescribeRequest): RuleMatch[] {
    const matches = describeNodes(this.#index(req.scanId), req.nodeIds)
    if (!matches) throw new AppError('NOT_FOUND', '항목을 찾을 수 없습니다.')
    return matches
  }

  getTypeSummary(scanId: string): TypeSummary[] {
    return this.#index(scanId).result.typeSummary
  }

  getSkipped(scanId: string): SkippedResponse {
    const { result } = this.#index(scanId)
    return { total: result.summary.skippedCount, items: result.skippedSample }
  }

  /** 루트부터 해당 폴더까지의 노드 ID (스캔 탭에서 위치를 펼쳐 보여 줄 때 쓴다) */
  getAncestors(scanId: string, nodeId: string): string[] {
    const ids = ancestorIds(this.#index(scanId), nodeId)
    if (!ids) throw new AppError('NOT_FOUND', '폴더를 찾을 수 없습니다.')
    return ids
  }

  /** 현재 스캔 결과에서 경로가 정확히 일치하는 폴더 (없으면 null). 설치 폴더 연결에 쓴다 */
  locate(path: string): { scanId: string; nodeId: string; size: number } | null {
    if (!this.#current) return null
    const node = findNodeByPath(this.#current, path)
    return node
      ? { scanId: this.#current.result.summary.scanId, nodeId: node.id, size: node.size }
      : null
  }

  /** ID → 실제 경로 (탐색기 열기/경로 복사용). 모르는 ID는 NOT_FOUND */
  resolve(scanId: string, nodeId: string): string {
    const path = resolvePath(this.#index(scanId), nodeId)
    if (!path) throw new AppError('NOT_FOUND', '항목을 찾을 수 없습니다.')
    return path
  }
}
