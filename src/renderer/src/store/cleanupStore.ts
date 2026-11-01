import { create } from 'zustand'
import type {
  CleanupItem,
  CleanupMode,
  CleanupPlan,
  CleanupProgress,
  CleanupResult
} from '@shared/cleanup'
import type { IpcResult } from '@shared/ipc'
import {
  IDLE_ANALYSIS,
  defaultSelection,
  isSelectable,
  oneClickSelection,
  safeSelection,
  type ItemAnalysis
} from '../lib/cleanupView'
import { useNavStore } from './navStore'
import { useScanStore } from './scanStore'

export type CleanupPhase = 'idle' | 'analyzing' | 'planning' | 'confirm' | 'running' | 'result'

interface CleanupState {
  items: CleanupItem[] | null
  loadError: string | null
  selected: Set<string>
  analysis: Record<string, ItemAnalysis>
  detailId: string | null
  phase: CleanupPhase
  plan: CleanupPlan | null
  planError: string | null
  jobId: string | null
  progress: CleanupProgress | null
  result: CleanupResult | null
  allowPermanent: boolean
  /** 스캔 상세의 "이 항목 정리하기"가 요청한 항목 (정리 화면이 열리면 바로 확인 단계로) */
  pendingItemId: string | null

  init: () => Promise<void>
  loadItems: () => Promise<void>
  toggle: (itemId: string) => void
  selectSafe: () => void
  clearSelection: () => void
  showDetail: (itemId: string | null) => void
  analyzeAll: () => Promise<void>
  openConfirm: (itemIds: string[], mode?: CleanupMode) => Promise<void>
  oneClick: () => Promise<void>
  requestItem: (itemId: string) => void
  cancelConfirm: () => void
  run: (acknowledgeCaution: boolean) => Promise<void>
  cancelRun: () => Promise<void>
  dismissResult: () => void
}

const errorText = (r: Extract<IpcResult<unknown>, { ok: false }>): string => r.message

let subscribed = false

export const useCleanupStore = create<CleanupState>((set, get) => ({
  items: null,
  loadError: null,
  selected: new Set(),
  analysis: {},
  detailId: null,
  phase: 'idle',
  plan: null,
  planError: null,
  jobId: null,
  progress: null,
  result: null,
  allowPermanent: false,
  pendingItemId: null,

  init: async () => {
    if (!subscribed) {
      subscribed = true
      window.api.cleanup.onProgress((progress) => set({ progress }))
      window.api.cleanup.onDone((result) => {
        set({ phase: 'result', result, progress: null, jobId: null, plan: null })
        void useScanStore.getState().refreshDrive()
        useScanStore.getState().setNotice({
          kind: result.error ? 'error' : 'info',
          text: result.cancelled ? '정리를 중단했습니다.' : '정리가 끝났습니다.'
        })
      })
    }
    const settings = await window.api.settings.get()
    if (settings.ok) set({ allowPermanent: settings.data.allowPermanentDelete })
    await get().loadItems()
  },

  loadItems: async () => {
    const r = await window.api.cleanup.items()
    if (!r.ok) {
      set({ loadError: errorText(r) })
      return
    }
    set((s) => ({
      items: r.data,
      loadError: null,
      // 처음 한 번만 기본 선택을 적용한다 (사용자가 바꾼 선택을 다시 덮어쓰지 않는다)
      selected: s.items === null ? defaultSelection(r.data) : s.selected
    }))
  },

  toggle: (itemId) => {
    const item = get().items?.find((i) => i.itemId === itemId)
    if (!item || !isSelectable(item)) return
    set((s) => {
      const next = new Set(s.selected)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return { selected: next }
    })
  },

  selectSafe: () => set((s) => ({ selected: safeSelection(s.items ?? []) })),
  clearSelection: () => set({ selected: new Set() }),
  showDetail: (detailId) => set({ detailId }),

  analyzeAll: async () => {
    const items = (get().items ?? []).filter(isSelectable)
    if (items.length === 0 || get().phase !== 'idle') return
    set({
      phase: 'analyzing',
      analysis: Object.fromEntries(
        items.map((i) => [i.itemId, { ...IDLE_ANALYSIS, status: 'running' }])
      )
    })
    for (const item of items) {
      const r = await window.api.cleanup.analyze({ itemId: item.itemId })
      set((s) => ({
        analysis: {
          ...s.analysis,
          [item.itemId]: r.ok
            ? { ...r.data, status: 'done' }
            : { ...IDLE_ANALYSIS, status: 'error', warnings: [errorText(r)] }
        }
      }))
    }
    set({ phase: 'idle' })
  },

  openConfirm: async (itemIds, mode = 'trash') => {
    if (itemIds.length === 0 || (get().phase !== 'idle' && get().phase !== 'confirm')) return
    set({ phase: 'planning', planError: null })
    const r = await window.api.cleanup.plan({ itemIds, mode })
    if (r.ok) set({ phase: 'confirm', plan: r.data })
    else {
      // 실패해도 목록 화면으로 돌아가 이유를 보여 준다
      set({ phase: 'idle', plan: null, planError: errorText(r) })
    }
  },

  oneClick: async () => {
    const items = get().items ?? []
    const ids = oneClickSelection(items)
    if (ids.length === 0 || get().phase !== 'idle') return
    // 분석 → safe 항목 자동 선택 → 확인 대화상자 (확인 단계는 생략하지 않는다)
    set({ selected: new Set(ids) })
    await get().analyzeAll()
    await get().openConfirm(ids, 'trash')
  },

  requestItem: (itemId) => {
    set({ pendingItemId: itemId })
    useNavStore.getState().setActive('cleanup')
  },

  cancelConfirm: () => {
    if (get().phase === 'confirm') set({ phase: 'idle', plan: null })
  },

  run: async (acknowledgeCaution) => {
    const plan = get().plan
    if (!plan || get().phase !== 'confirm') return
    set({ phase: 'running', progress: null, planError: null })
    const r = await window.api.cleanup.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution
    })
    if (r.ok) {
      // 완료 이벤트가 먼저 도착했을 수 있으므로 phase 는 건드리지 않는다
      if (get().phase === 'running') set({ jobId: r.data.jobId })
    } else {
      set({ phase: 'idle', plan: null, planError: errorText(r) })
    }
  },

  cancelRun: async () => {
    const jobId = get().jobId
    if (jobId) await window.api.cleanup.cancel({ jobId })
  },

  dismissResult: () =>
    set((s) => ({
      phase: 'idle',
      result: null,
      // 용량이 바뀌었으므로 분석 결과는 무효
      analysis: Object.fromEntries(Object.keys(s.analysis).map((k) => [k, { ...IDLE_ANALYSIS }]))
    }))
}))
