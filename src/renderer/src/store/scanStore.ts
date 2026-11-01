import { create } from 'zustand'
import type { IpcResult, SafetyFilter } from '@shared/ipc'
import type { DriveInfo, NodeView, ScanProgress, ScanSummary, TypeSummary } from '@shared/types'

export type ScanTab = 'tree' | 'topFiles' | 'topFolders' | 'types'
export interface Notice {
  kind: 'info' | 'error'
  text: string
}

const CHILD_LIMIT = 2000
const TOP_LIMIT = 200
const FIND_LIMIT = 300

export interface Filter {
  safety: SafetyFilter
  cleanableOnly: boolean
  query: string
}
export const NO_FILTER: Filter = { safety: 'all', cleanableOnly: false, query: '' }
export const isFiltering = (f: Filter): boolean =>
  f.safety !== 'all' || f.cleanableOnly || f.query.trim() !== ''

interface ScanState {
  initialized: boolean
  scanning: boolean
  runningScanId: string | null
  progress: ScanProgress | null
  summary: ScanSummary | null
  fromCache: boolean
  drive: DriveInfo | null
  rootView: NodeView | null
  children: Record<string, NodeView[]>
  expanded: Record<string, true>
  loading: Record<string, true>
  selected: NodeView | null
  tab: ScanTab
  topFiles: NodeView[] | null
  topFolders: NodeView[] | null
  types: TypeSummary[] | null
  notice: Notice | null
  /** reveal 이 일어날 때마다 증가. 트리가 선택 행으로 스크롤하는 신호 */
  revealSeq: number
  filter: Filter
  found: NodeView[] | null

  setFilter: (patch: Partial<Filter>) => Promise<void>
  init: () => Promise<void>
  /** 드라이브 사용량(상단바)을 다시 읽는다. 정리 후 호출 */
  refreshDrive: () => Promise<void>
  startScan: () => Promise<void>
  cancelScan: () => Promise<void>
  toggle: (nodeId: string) => Promise<void>
  expand: (nodeId: string) => Promise<void>
  collapse: (nodeId: string) => void
  select: (view: NodeView | null) => void
  setTab: (tab: ScanTab) => Promise<void>
  showInExplorer: (view: NodeView) => Promise<void>
  copyPath: (view: NodeView) => Promise<void>
  setNotice: (notice: Notice | null) => void
  /** 스캔 탭의 트리에서 해당 폴더 위치를 펼쳐 선택한다 (프로그램 설치 폴더 보기용) */
  reveal: (scanId: string, nodeId: string) => Promise<void>
}

function rootViewOf(summary: ScanSummary): NodeView {
  return {
    id: summary.rootNodeId,
    kind: 'folder',
    name: summary.root,
    path: summary.root,
    size: summary.totalBytes,
    percentOfParent: 1,
    percentOfTotal: 1,
    fileCount: summary.totalFiles,
    hasChildren: true,
    match: { ruleId: null, safety: 'unknown', cleanable: false, canDelete: false }
  }
}

function errorText<T>(result: IpcResult<T>): string {
  return result.ok ? '' : result.message
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined

export const useScanStore = create<ScanState>((set, get) => {
  /** 새 결과(스캔 완료 또는 캐시)를 화면 상태로 채택하고 루트 하위를 펼친다 */
  const adopt = async (summary: ScanSummary, fromCache: boolean): Promise<void> => {
    const rootView = rootViewOf(summary)
    set({
      summary,
      fromCache,
      rootView,
      children: {},
      expanded: { [rootView.id]: true },
      loading: {},
      selected: rootView,
      topFiles: null,
      topFolders: null,
      types: null,
      filter: NO_FILTER,
      found: null
    })
    // 루트(드라이브)의 설명·안전도는 규칙 매칭으로 가져온다
    const d = await window.api.rules.describe({ scanId: summary.scanId, nodeIds: [rootView.id] })
    const rootMatch = d.ok ? d.data[0] : undefined
    if (rootMatch && get().summary?.scanId === summary.scanId) {
      const withMatch = { ...rootView, match: rootMatch }
      set((s) => ({
        rootView: withMatch,
        selected: s.selected?.id === rootView.id ? withMatch : s.selected
      }))
    }
    await get().expand(rootView.id)
    if (get().tab !== 'tree') await get().setTab(get().tab)
  }

  return {
    initialized: false,
    scanning: false,
    runningScanId: null,
    progress: null,
    summary: null,
    fromCache: false,
    drive: null,
    rootView: null,
    children: {},
    expanded: {},
    loading: {},
    selected: null,
    tab: 'tree',
    topFiles: null,
    topFolders: null,
    types: null,
    notice: null,
    revealSeq: 0,
    filter: NO_FILTER,
    found: null,

    setFilter: async (patch) => {
      const filter = { ...get().filter, ...patch }
      set({ filter })
      const { summary } = get()
      if (!summary || !isFiltering(filter)) {
        set({ found: null })
        return
      }
      const r = await window.api.scan.find({ scanId: summary.scanId, ...filter, limit: FIND_LIMIT })
      // 응답이 늦게 도착했는데 그 사이 필터가 바뀌었으면 버린다
      if (get().filter !== filter) return
      if (r.ok) set({ found: r.data })
      else get().setNotice({ kind: 'error', text: errorText(r) })
    },

    setNotice: (notice) => {
      clearTimeout(noticeTimer)
      set({ notice })
      if (notice && notice.kind === 'info') {
        noticeTimer = setTimeout(() => set({ notice: null }), 4000)
      }
    },

    init: async () => {
      if (get().initialized) return
      set({ initialized: true })
      // 이벤트 구독은 앱 전체에서 한 번만 (탭을 옮겨도 스캔 상태가 유지된다)
      window.api.scan.onProgress((progress) => set({ progress }))
      window.api.scan.onDone((summary) => {
        set({ scanning: false, runningScanId: null, progress: null })
        if (summary.cancelled) {
          get().setNotice({
            kind: 'info',
            text: '스캔을 취소했습니다. 이전 결과를 그대로 보여 드립니다.'
          })
          return
        }
        if (summary.driveInfo) {
          set({ drive: { root: summary.root, ...summary.driveInfo } })
        }
        void adopt(summary, false)
        get().setNotice({ kind: 'info', text: '스캔이 끝났습니다.' })
      })
      window.api.scan.onError((message) => {
        set({ scanning: false, runningScanId: null, progress: null })
        get().setNotice({ kind: 'error', text: `스캔에 실패했습니다: ${message}` })
      })

      const drive = await window.api.getDriveInfo()
      if (drive.ok) set({ drive: drive.data })
      const cached = await window.api.scan.loadCache()
      if (cached.ok && cached.data) await adopt(cached.data.summary, true)
    },

    refreshDrive: async () => {
      const drive = await window.api.getDriveInfo()
      if (drive.ok) set({ drive: drive.data })
    },

    startScan: async () => {
      if (get().scanning) return
      const res = await window.api.scan.start()
      if (!res.ok) {
        get().setNotice({ kind: 'error', text: errorText(res) })
        return
      }
      set({ scanning: true, runningScanId: res.data.scanId, progress: null })
    },

    cancelScan: async () => {
      const id = get().runningScanId
      if (!id) return
      const res = await window.api.scan.cancel({ scanId: id })
      if (!res.ok) get().setNotice({ kind: 'error', text: errorText(res) })
    },

    expand: async (nodeId) => {
      const { summary, children, loading } = get()
      if (!summary) return
      set((s) => ({ expanded: { ...s.expanded, [nodeId]: true } }))
      if (children[nodeId] || loading[nodeId]) return
      set((s) => ({ loading: { ...s.loading, [nodeId]: true } }))
      const res = await window.api.scan.getChildren({
        scanId: summary.scanId,
        nodeId,
        sort: 'size',
        limit: CHILD_LIMIT,
        offset: 0
      })
      set((s) => {
        const loadingNext = { ...s.loading }
        delete loadingNext[nodeId]
        return res.ok
          ? { loading: loadingNext, children: { ...s.children, [nodeId]: res.data } }
          : { loading: loadingNext }
      })
      if (!res.ok) get().setNotice({ kind: 'error', text: errorText(res) })
    },

    collapse: (nodeId) =>
      set((s) => {
        const next = { ...s.expanded }
        delete next[nodeId]
        return { expanded: next }
      }),

    toggle: async (nodeId) => {
      if (get().expanded[nodeId]) get().collapse(nodeId)
      else await get().expand(nodeId)
    },

    select: (view) => set({ selected: view }),

    reveal: async (scanId, nodeId) => {
      const { summary } = get()
      if (!summary || summary.scanId !== scanId) {
        get().setNotice({
          kind: 'info',
          text: '스캔 결과가 바뀌었습니다. 프로그램 목록을 새로 고쳐 주세요.'
        })
        return
      }
      await get().setFilter(NO_FILTER)
      set({ tab: 'tree' })
      const r = await window.api.scan.getAncestors({ scanId, nodeId })
      if (!r.ok) {
        get().setNotice({ kind: 'error', text: errorText(r) })
        return
      }
      const chain = r.data
      for (const id of chain.slice(0, -1)) await get().expand(id)
      const parentId = chain.at(-2)
      const view = parentId
        ? get().children[parentId]?.find((v) => v.id === nodeId)
        : get().rootView
      if (!view) {
        get().setNotice({ kind: 'info', text: '스캔 결과에서 이 폴더를 찾지 못했습니다.' })
        return
      }
      set((s) => ({ selected: view, revealSeq: s.revealSeq + 1 }))
    },

    setTab: async (tab) => {
      set({ tab })
      const { summary } = get()
      if (!summary) return
      const scanId = summary.scanId
      if (tab === 'topFiles' && !get().topFiles) {
        const r = await window.api.scan.getTop({ scanId, kind: 'files', limit: TOP_LIMIT })
        if (r.ok) set({ topFiles: r.data })
      } else if (tab === 'topFolders' && !get().topFolders) {
        const r = await window.api.scan.getTop({ scanId, kind: 'folders', limit: TOP_LIMIT })
        if (r.ok) set({ topFolders: r.data })
      } else if (tab === 'types' && !get().types) {
        const r = await window.api.scan.getTypeSummary({ scanId })
        if (r.ok) set({ types: r.data })
      }
    },

    showInExplorer: async (view) => {
      const { summary } = get()
      if (!summary) return
      const r = await window.api.shell.showInExplorer({ scanId: summary.scanId, nodeId: view.id })
      if (!r.ok) get().setNotice({ kind: 'error', text: errorText(r) })
    },

    copyPath: async (view) => {
      const { summary } = get()
      if (!summary) return
      const r = await window.api.shell.copyPath({ scanId: summary.scanId, nodeId: view.id })
      get().setNotice(
        r.ok
          ? { kind: 'info', text: '경로를 복사했습니다.' }
          : { kind: 'error', text: errorText(r) }
      )
    }
  }
})
