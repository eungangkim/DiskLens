// 스캔 결과 → UI용 뷰 모델 변환 (순수 함수, 읽기 전용). 경로 해석도 여기서 한다:
// renderer는 경로가 아니라 ID만 보내고, main이 ID → 경로로 바꾼다 (ARCHITECTURE.md §4.3).
// 규칙 매칭은 조회 시점에 한다 (스캔 성능 보호, ARCHITECTURE.md §8).
import type { FolderNode, NodeView, RuleMatch, ScanResult } from '../../shared/types.ts'
import type { FindRequest, ScanSort } from '../../shared/ipc.ts'
import { normalizeKey } from '../rules/paths.ts'
import { NO_RULES, type Lookup, type RuleLookup } from '../rules/matcher.ts'

export interface ScanIndex {
  result: ScanResult
  byId: Map<string, FolderNode>
  rules: RuleLookup
  /** 필터용 지연 계산 캐시 */
  cache: {
    ruleRoots?: Array<{ node: FolderNode; look: Lookup }>
    bySize?: FolderNode[]
    byPath?: Map<string, FolderNode>
  }
}

export function buildIndex(result: ScanResult, rules: RuleLookup = NO_RULES): ScanIndex {
  return { result, byId: new Map(result.nodes.map((n) => [n.id, n])), rules, cache: {} }
}

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0)

function folderView(index: ScanIndex, n: FolderNode, parentSize: number, look?: Lookup): NodeView {
  const total = index.result.summary.totalBytes
  const view: NodeView = {
    id: n.id,
    kind: 'folder',
    name: n.name,
    path: n.path,
    size: n.size,
    percentOfParent: ratio(n.size, parentSize),
    percentOfTotal: ratio(n.size, total),
    fileCount: n.fileCount,
    hasChildren: n.childIds.length > 0 || (n.collapsed?.count ?? 0) > 0 || n.ownFileCount > 0,
    match: (look ?? index.rules.lookup(n.path)).match
  }
  if (n.isLink) view.isLink = true
  if (n.cloudOnly) view.cloudOnly = true
  return view
}

function sortViews(views: NodeView[], sort: ScanSort): NodeView[] {
  const copy = [...views]
  if (sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  else if (sort === 'files')
    copy.sort((a, b) => (b.fileCount ?? 0) - (a.fileCount ?? 0) || b.size - a.size)
  else copy.sort((a, b) => b.size - a.size)
  return copy
}

/** 폴더의 하위 항목: 하위 폴더 + "기타 N개 폴더" + "직접 포함된 파일" 합성 행 */
export function getChildren(
  index: ScanIndex,
  nodeId: string,
  sort: ScanSort,
  limit: number,
  offset: number
): NodeView[] | null {
  const parent = index.byId.get(nodeId)
  if (!parent) return null
  const total = index.result.summary.totalBytes
  const views: NodeView[] = []
  for (const id of parent.childIds) {
    const child = index.byId.get(id)
    if (child) views.push(folderView(index, child, parent.size))
  }
  // 합성 행은 부모 규칙이 하위로 상속되는 경우에만 설명을 물려받는다
  const inherited = (): RuleMatch => index.rules.lookupChild(parent.path)
  if (parent.collapsed && parent.collapsed.count > 0) {
    views.push({
      id: `col:${parent.id}`,
      kind: 'collapsed',
      name: `기타 ${parent.collapsed.count.toLocaleString('ko-KR')}개 폴더 (작은 폴더 합계)`,
      path: parent.path,
      size: parent.collapsed.size,
      percentOfParent: ratio(parent.collapsed.size, parent.size),
      percentOfTotal: ratio(parent.collapsed.size, total),
      hasChildren: false,
      match: inherited()
    })
  }
  if (parent.ownFileCount > 0) {
    views.push({
      id: `own:${parent.id}`,
      kind: 'collapsed',
      name: `이 폴더 바로 아래 파일 ${parent.ownFileCount.toLocaleString('ko-KR')}개`,
      path: parent.path,
      size: parent.ownFilesSize,
      percentOfParent: ratio(parent.ownFilesSize, parent.size),
      percentOfTotal: ratio(parent.ownFilesSize, total),
      fileCount: parent.ownFileCount,
      hasChildren: false,
      match: inherited()
    })
  }
  return sortViews(views, sort).slice(offset, offset + limit)
}

/** 용량의 90% 이상이 하위 폴더 하나에 들어 있는 "통과 폴더"인가 */
function isPassThrough(index: ScanIndex, n: FolderNode): boolean {
  let biggestChild = 0
  for (const id of n.childIds) biggestChild = Math.max(biggestChild, index.byId.get(id)?.size ?? 0)
  return biggestChild >= n.size * 0.9
}

function sortedBySize(index: ScanIndex): FolderNode[] {
  index.cache.bySize ??= index.result.nodes
    .filter((n) => n.id !== index.result.summary.rootNodeId && !n.isLink && n.size > 0)
    .sort((a, b) => b.size - a.size)
  return index.cache.bySize
}

/**
 * 큰 폴더 Top: 용량 순. 단, 용량의 90% 이상이 하위 폴더 하나에 들어 있는 "통과 폴더"
 * (예: Users → user → AppData …)는 제외해서 가장 안쪽의 실제 큰 폴더가 보이게 한다.
 */
export function getTopFolders(index: ScanIndex, limit: number): NodeView[] {
  const out: NodeView[] = []
  for (const n of sortedBySize(index)) {
    if (out.length >= limit) break
    if (isPassThrough(index, n)) continue
    out.push(folderView(index, n, index.byId.get(n.parentId ?? '')?.size ?? 0))
  }
  return out
}

export function getTopFiles(index: ScanIndex, limit: number): NodeView[] {
  const total = index.result.summary.totalBytes
  return index.result.topFiles.slice(0, limit).map((f, i): NodeView => {
    const sep = f.path.lastIndexOf('\\')
    return {
      id: `f:${i}`,
      kind: 'file',
      name: sep >= 0 ? f.path.slice(sep + 1) : f.path,
      path: f.path,
      size: f.size,
      percentOfParent: 0,
      percentOfTotal: ratio(f.size, total),
      hasChildren: false,
      modifiedAt: f.modifiedAt,
      ext: f.ext,
      match: index.rules.lookup(f.path).match
    }
  })
}

/** 규칙이 가리키는 대상 폴더(규칙 루트) 전체. 처음 필요할 때 한 번 계산해 둔다 */
function ruleRoots(index: ScanIndex): Array<{ node: FolderNode; look: Lookup }> {
  if (!index.cache.ruleRoots) {
    const roots: Array<{ node: FolderNode; look: Lookup }> = []
    for (const node of index.result.nodes) {
      if (node.id === index.result.summary.rootNodeId || node.isLink) continue
      const look = index.rules.lookup(node.path)
      if (look.root && look.match.ruleId !== null) roots.push({ node, look })
    }
    roots.sort((a, b) => b.node.size - a.node.size)
    index.cache.ruleRoots = roots
  }
  return index.cache.ruleRoots
}

/**
 * 안전도 필터 / "지워도 되는 것만" / 이름 검색 결과를 큰 순 평면 목록으로 돌려준다 (UI_SPEC.md §3.3).
 * - safe/caution/protected: 그 안전도 규칙이 직접 가리키는 폴더(규칙 루트)
 * - cleanableOnly: 안전(safe) + 정리 가능(cleanable) 규칙 루트
 * - unknown: 규칙이 없는 폴더 중 가장 안쪽의 큰 폴더 (통과 폴더 제외)
 * - all: 규칙 상관없이 이름 검색만 적용
 */
export function findNodes(index: ScanIndex, req: Omit<FindRequest, 'scanId'>): NodeView[] {
  const query = req.query.trim().toLowerCase()
  const nameOk = (n: FolderNode): boolean => query === '' || n.name.toLowerCase().includes(query)
  const parentSize = (n: FolderNode): number => index.byId.get(n.parentId ?? '')?.size ?? 0
  const out: NodeView[] = []

  if (req.safety === 'unknown' && !req.cleanableOnly) {
    for (const n of sortedBySize(index)) {
      if (out.length >= req.limit) break
      if (!nameOk(n) || isPassThrough(index, n)) continue
      const look = index.rules.lookup(n.path)
      if (look.match.safety === 'unknown') out.push(folderView(index, n, parentSize(n), look))
    }
    return out
  }

  if (req.safety === 'all' && !req.cleanableOnly) {
    for (const n of sortedBySize(index)) {
      if (out.length >= req.limit) break
      if (nameOk(n)) out.push(folderView(index, n, parentSize(n)))
    }
    return out
  }

  for (const { node, look } of ruleRoots(index)) {
    if (out.length >= req.limit) break
    if (!nameOk(node)) continue
    const m = look.match
    if (req.cleanableOnly) {
      if (!(m.safety === 'safe' && m.cleanable)) continue
    } else if (req.safety !== 'all' && m.safety !== req.safety) continue
    out.push(folderView(index, node, parentSize(node), look))
  }
  return out
}

/** 노드 ID 여러 개의 규칙 매칭 (rules:describe). 모르는 ID가 하나라도 있으면 null */
export function describeNodes(index: ScanIndex, ids: readonly string[]): RuleMatch[] | null {
  const out: RuleMatch[] = []
  for (const id of ids) {
    if (id.startsWith('col:') || id.startsWith('own:')) {
      const parent = index.byId.get(id.slice(4))
      if (!parent) return null
      out.push(index.rules.lookupChild(parent.path))
    } else {
      const path = resolvePath(index, id)
      if (path === null) return null
      out.push(index.rules.lookup(path).match)
    }
  }
  return out
}

/**
 * ID → 실제 경로. 합성 행(col:/own:)은 부모 폴더 경로를 돌려준다.
 * 모르는 ID면 null (renderer가 임의 경로를 만들어 보낼 수 없다).
 */
export function resolvePath(index: ScanIndex, id: string): string | null {
  if (id.startsWith('f:')) {
    const i = Number(id.slice(2))
    return Number.isInteger(i) ? (index.result.topFiles[i]?.path ?? null) : null
  }
  const folderId = id.startsWith('col:') || id.startsWith('own:') ? id.slice(4) : id
  return index.byId.get(folderId)?.path ?? null
}

/** 경로로 스캔 노드를 찾는다 (설치 폴더 연결용). 스캔에서 "기타"로 접힌 폴더나 스캔 밖 경로는 null */
export function findNodeByPath(index: ScanIndex, path: string): FolderNode | null {
  if (!index.cache.byPath) {
    index.cache.byPath = new Map(index.result.nodes.map((n) => [normalizeKey(n.path), n]))
  }
  return index.cache.byPath.get(normalizeKey(path)) ?? null
}

/** 루트부터 해당 폴더까지의 노드 ID (양 끝 포함). 합성 행 ID(col:/own:)는 부모 폴더로 본다 */
export function ancestorIds(index: ScanIndex, id: string): string[] | null {
  const folderId = id.startsWith('col:') || id.startsWith('own:') ? id.slice(4) : id
  let node = index.byId.get(folderId)
  if (!node) return null
  const chain: string[] = []
  for (let guard = 0; node && guard < 4096; guard++) {
    chain.push(node.id)
    node = node.parentId === null ? undefined : index.byId.get(node.parentId)
  }
  return chain.reverse()
}
