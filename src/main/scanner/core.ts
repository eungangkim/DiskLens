// 스캔 엔진 핵심 (ARCHITECTURE.md §5). worker 안에서 실행되지만, 단위 테스트에서는 직접 호출할 수 있다.
// 읽기 전용: 파일을 열람/stat 할 뿐 쓰기나 삭제는 하지 않는다.
import { lstat as fsLstat, opendir as fsOpendir, statfs as fsStatfs } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, sep } from 'node:path'
import { defaultScanOptions } from '../../shared/types.ts'
import type {
  FolderNode,
  ScanOptions,
  ScanProgress,
  ScanResult,
  SkippedItem,
  SkipReason,
  TopFileEntry,
  TypeSummary,
  FileType
} from '../../shared/types.ts'
import { classifyExtension, extensionOf } from './fileTypes.ts'

/** 파일 시스템 접근 추상화 (테스트에서 권한 오류/지연을 흉내내기 위해 주입 가능) */
export interface DirHandle extends AsyncIterable<Dirent> {
  close(): Promise<void>
}
export interface ScanFs {
  opendir(path: string): Promise<DirHandle>
  lstat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean }>
}

export const realFs: ScanFs = {
  opendir: (path) => fsOpendir(path, { bufferSize: 512 }),
  lstat: (path) => fsLstat(path)
}

export interface CancelToken {
  cancelled: boolean
}

export interface ScanHooks {
  scanId: string
  onProgress?: (progress: ScanProgress) => void
  /** 진행 이벤트 간격(ms). 기본 200 */
  progressIntervalMs?: number
  fs?: ScanFs
  token?: CancelToken
}

interface WorkNode {
  id: string
  parent: WorkNode | null
  depth: number
  name: string
  path: string
  size: number
  ownFilesSize: number
  ownFileCount: number
  fileCount: number
  dirCount: number
  children: WorkNode[]
  collapsedCount: number
  collapsedSize: number
  isLink: boolean
  skippedChildren: number
  truncated: boolean
  /** 아직 끝나지 않은 자식 폴더 수 */
  pending: number
  /** 이 폴더의 항목 나열이 끝났는지 */
  listed: boolean
  finalized: boolean
  /** 규칙 경로이거나 그 하위에 유지해야 할 폴더가 있어 접으면 안 되는 폴더 */
  isKeep: boolean
  hasPinnedChild: boolean
}

function joinPath(base: string, name: string): string {
  return base.endsWith(sep) ? base + name : base + sep + name
}

function skipReasonOf(error: unknown): SkipReason {
  const code = (error as { code?: string } | null)?.code
  if (code === 'EPERM' || code === 'EACCES') return 'permission-denied'
  if (code === 'EBUSY') return 'busy'
  if (code === 'ENOENT') return 'not-found'
  return 'other'
}

const FILE_BATCH = 256

export async function runScan(
  rootInput: string,
  optionsInput: Partial<ScanOptions>,
  hooks: ScanHooks
): Promise<ScanResult> {
  const options: ScanOptions = { ...defaultScanOptions(), ...optionsInput }
  const fs = hooks.fs ?? realFs
  const token = hooks.token ?? { cancelled: false }
  const root = resolve(rootInput)
  const startedAt = new Date()
  const t0 = Date.now()

  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory()) throw new Error('NOT_A_DIRECTORY')

  const excluded = new Set(options.excludePaths.map((p) => resolve(p).toLowerCase()))
  const keepPaths = new Set(options.keepPaths.map((p) => resolve(p).toLowerCase()))
  const keepNames = new Set(options.keepNames.map((n) => n.toLowerCase()))
  const cluster = Math.max(1, options.clusterSize)
  const sizeOf = (logical: number): number =>
    options.allocatedSize ? (logical === 0 ? 0 : Math.ceil(logical / cluster) * cluster) : logical

  // --- 집계 상태 ---
  let nextId = 0
  let filesScanned = 0
  let dirsScanned = 0
  let bytesScanned = 0
  let skippedCount = 0
  let currentPath = root
  const skippedSample: SkippedItem[] = []
  const typeAgg = new Map<FileType, { bytes: number; fileCount: number }>()
  /** 오름차순 정렬 유지(맨 앞이 최소). 길이 ≤ topFilesK */
  const top: TopFileEntry[] = []
  const open = new Set<WorkNode>()
  const stack: WorkNode[] = []
  let active = 0
  const waiters: Array<() => void> = []

  const noteSkip = (path: string, error: unknown): void => {
    skippedCount++
    if (skippedSample.length < options.skippedSampleMax) {
      skippedSample.push({ path, reason: skipReasonOf(error) })
    }
  }

  const newNode = (parent: WorkNode | null, name: string, path: string): WorkNode => {
    const lower = path.toLowerCase()
    return {
      id: String(nextId++),
      parent,
      depth: parent ? parent.depth + 1 : 0,
      name,
      path,
      size: 0,
      ownFilesSize: 0,
      ownFileCount: 0,
      fileCount: 0,
      dirCount: 0,
      children: [],
      collapsedCount: 0,
      collapsedSize: 0,
      isLink: false,
      skippedChildren: 0,
      truncated: false,
      pending: 0,
      listed: false,
      finalized: false,
      isKeep: keepPaths.has(lower) || keepNames.has(name.toLowerCase()),
      hasPinnedChild: false
    }
  }

  const wakeOne = (): void => {
    const w = waiters.pop()
    if (w) w()
  }
  const wakeAll = (): void => {
    while (waiters.length) waiters.pop()?.()
  }

  /** 끝난 폴더를 부모에 합산하고, 부모도 끝났으면 위로 계속 올라간다 (재귀 없이 반복) */
  const tryFinalize = (start: WorkNode): void => {
    let n: WorkNode | null = start
    while (n && n.listed && n.pending === 0 && !n.finalized) {
      n.finalized = true
      open.delete(n)
      const p: WorkNode | null = n.parent
      if (!p) break
      p.size += n.size
      p.fileCount += n.fileCount
      p.dirCount += n.dirCount + 1
      const pinned = n.isKeep || n.hasPinnedChild
      if (n.size < options.collapseThresholdBytes && !pinned) {
        p.collapsedCount++
        p.collapsedSize += n.size
      } else {
        p.children.push(n)
        if (pinned) p.hasPinnedChild = true
      }
      p.pending--
      n = p
    }
  }

  const addFile = (dir: WorkNode, name: string, logicalSize: number, mtimeMs: number): void => {
    const size = sizeOf(logicalSize)
    dir.ownFilesSize += size
    dir.ownFileCount++
    dir.size += size
    dir.fileCount++
    filesScanned++
    bytesScanned += size

    const ext = extensionOf(name)
    const type = classifyExtension(ext)
    const agg = typeAgg.get(type)
    if (agg) {
      agg.bytes += size
      agg.fileCount++
    } else typeAgg.set(type, { bytes: size, fileCount: 1 })

    // Top-K: 채택될 때만 경로 문자열을 만든다
    if (options.topFilesK > 0 && (top.length < options.topFilesK || size > (top[0]?.size ?? 0))) {
      const entry: TopFileEntry = {
        path: joinPath(dir.path, name),
        size,
        modifiedAt: new Date(mtimeMs).toISOString(),
        ext
      }
      let lo = 0
      let hi = top.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((top[mid]?.size ?? 0) < size) lo = mid + 1
        else hi = mid
      }
      top.splice(lo, 0, entry)
      if (top.length > options.topFilesK) top.shift()
    }
  }

  const flushFiles = async (dir: WorkNode, names: string[]): Promise<void> => {
    await Promise.all(
      names.map(async (name) => {
        const path = joinPath(dir.path, name)
        try {
          const st = await fs.lstat(path)
          addFile(dir, name, st.size, st.mtimeMs)
        } catch (error) {
          noteSkip(path, error)
          dir.truncated = true
        }
      })
    )
    names.length = 0
  }

  const processDir = async (dir: WorkNode): Promise<void> => {
    if (token.cancelled) return
    currentPath = dir.path
    try {
      const handle = await fs.opendir(dir.path)
      const names: string[] = []
      for await (const ent of handle) {
        if (token.cancelled) break
        if (ent.isSymbolicLink()) {
          // 링크/정션은 따라가지 않는다 (용량 0, 표시용 노드만)
          const link = newNode(dir, ent.name, joinPath(dir.path, ent.name))
          link.isLink = true
          link.listed = true
          link.finalized = true
          dir.children.push(link)
        } else if (ent.isDirectory()) {
          const path = joinPath(dir.path, ent.name)
          if (excluded.has(path.toLowerCase())) continue
          const child = newNode(dir, ent.name, path)
          dir.pending++
          open.add(child)
          stack.push(child)
          wakeOne()
        } else if (ent.isFile()) {
          names.push(ent.name)
          if (names.length >= FILE_BATCH) await flushFiles(dir, names)
        }
      }
      if (names.length > 0 && !token.cancelled) await flushFiles(dir, names)
    } catch (error) {
      noteSkip(dir.path, error)
      dir.truncated = true
      if (dir.parent) dir.parent.skippedChildren++
    }
    dirsScanned++
    if (!token.cancelled) {
      dir.listed = true
      tryFinalize(dir)
    }
  }

  const loop = async (): Promise<void> => {
    for (;;) {
      if (token.cancelled) return
      const node = stack.pop()
      if (node) {
        active++
        try {
          await processDir(node)
        } finally {
          active--
          if (active === 0 && stack.length === 0) wakeAll()
        }
        continue
      }
      if (active === 0) return
      await new Promise<void>((resolveWait) => waiters.push(resolveWait))
    }
  }

  // --- 실행 ---
  const rootNode = newNode(null, root, root)
  open.add(rootNode)
  stack.push(rootNode)

  const makeProgress = (): ScanProgress => ({
    scanId: hooks.scanId,
    filesScanned,
    dirsScanned,
    bytesScanned,
    skippedCount,
    currentPath,
    elapsedMs: Date.now() - t0
  })
  const timer = hooks.onProgress
    ? setInterval(() => hooks.onProgress?.(makeProgress()), hooks.progressIntervalMs ?? 200)
    : null

  try {
    const workers: Array<Promise<void>> = []
    for (let i = 0; i < Math.max(1, options.concurrency); i++) workers.push(loop())
    await Promise.all(workers)
  } finally {
    if (timer) clearInterval(timer)
  }

  // 취소된 경우: 끝나지 않은 폴더를 깊은 것부터 강제로 마무리해 부분 결과를 만든다
  if (token.cancelled) {
    const rest = [...open].sort((a, b) => b.depth - a.depth)
    for (const n of rest) {
      n.truncated = true
      n.listed = true
    }
    for (const n of rest) if (!n.finalized) tryFinalize(n)
  }
  hooks.onProgress?.(makeProgress())

  // --- 결과 만들기 (반복 DFS로 평탄화) ---
  const nodes: FolderNode[] = []
  const walk: WorkNode[] = [rootNode]
  while (walk.length > 0) {
    const n = walk.pop() as WorkNode
    n.children.sort((a, b) => b.size - a.size)
    const node: FolderNode = {
      id: n.id,
      parentId: n.parent ? n.parent.id : null,
      name: n.name,
      path: n.path,
      size: n.size,
      ownFilesSize: n.ownFilesSize,
      ownFileCount: n.ownFileCount,
      fileCount: n.fileCount,
      dirCount: n.dirCount,
      childIds: n.children.map((c) => c.id)
    }
    if (n.collapsedCount > 0) node.collapsed = { count: n.collapsedCount, size: n.collapsedSize }
    if (n.isLink) node.isLink = true
    if (n.skippedChildren > 0) node.skippedChildren = n.skippedChildren
    if (n.truncated) node.truncated = true
    nodes.push(node)
    for (const c of n.children) walk.push(c)
  }

  let driveInfo: { totalBytes: number; freeBytes: number } | undefined
  try {
    const s = await fsStatfs(root)
    driveInfo = {
      totalBytes: Number(s.blocks) * Number(s.bsize),
      freeBytes: Number(s.bavail) * Number(s.bsize)
    }
  } catch {
    driveInfo = undefined // 일부 환경에서는 지원되지 않을 수 있다
  }

  const typeSummary: TypeSummary[] = [...typeAgg.entries()]
    .map(([type, v]) => ({ type, bytes: v.bytes, fileCount: v.fileCount }))
    .sort((a, b) => b.bytes - a.bytes)

  return {
    summary: {
      scanId: hooks.scanId,
      root,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalBytes: rootNode.size,
      totalFiles: rootNode.fileCount,
      totalDirs: rootNode.dirCount + 1,
      skippedCount,
      cancelled: token.cancelled,
      allocatedSize: options.allocatedSize,
      rootNodeId: rootNode.id,
      ...(driveInfo ? { driveInfo } : {})
    },
    nodes,
    topFiles: [...top].reverse(),
    typeSummary,
    skippedSample
  }
}
