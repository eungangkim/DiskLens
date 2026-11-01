import { create } from 'zustand'
import type { InstalledProgram } from '@shared/types'
import type { UninstallPlan, UninstallResult } from '@shared/uninstall'
import type { ProgramSort } from '../lib/programList'

/** 제거 흐름 단계: 대기 → (계획 받는 중) → 확인 대화상자 → 제거 프로그램 실행 중 → 결과 */
export type UninstallPhase = 'idle' | 'planning' | 'confirming' | 'running'

interface ProgramsState {
  programs: InstalledProgram[] | null
  loading: boolean
  error: string | null
  includeSystem: boolean
  sort: ProgramSort
  query: string
  selectedId: string | null

  uninstallPhase: UninstallPhase
  uninstallPlan: UninstallPlan | null
  /** 실행 중인 프로그램 이름 (배너 표시용) */
  uninstallName: string | null
  uninstallResult: UninstallResult | null
  uninstallError: string | null

  load: (refresh?: boolean) => Promise<void>
  setIncludeSystem: (v: boolean) => void
  setSort: (s: ProgramSort) => void
  setQuery: (q: string) => void
  select: (id: string | null) => void

  /** 제거 완료 이벤트를 구독한다 (앱 시작 때 한 번) */
  initUninstall: () => void
  requestUninstall: (programId: string) => Promise<void>
  cancelUninstall: () => void
  confirmUninstall: (acknowledgeCaution: boolean) => Promise<void>
  dismissUninstallResult: () => void
}

let subscribed = false

export const useProgramsStore = create<ProgramsState>((set, get) => ({
  programs: null,
  loading: false,
  error: null,
  includeSystem: false,
  sort: 'size',
  query: '',
  selectedId: null,

  uninstallPhase: 'idle',
  uninstallPlan: null,
  uninstallName: null,
  uninstallResult: null,
  uninstallError: null,

  load: async (refresh = false) => {
    if (get().loading) return
    set({ loading: true, error: null })
    // 시스템 구성요소까지 모두 받아 두고, 표시 여부는 화면에서 거른다
    const r = await window.api.programs.list({ includeSystem: true, refresh })
    if (r.ok) set({ programs: r.data, loading: false })
    else set({ loading: false, error: r.message })
  },
  setIncludeSystem: (includeSystem) => set({ includeSystem }),
  setSort: (sort) => set({ sort }),
  setQuery: (query) => set({ query }),
  select: (selectedId) => set({ selectedId }),

  initUninstall: () => {
    if (subscribed) return
    subscribed = true
    window.api.programs.onUninstallDone((result) => {
      set({
        uninstallPhase: 'idle',
        uninstallPlan: null,
        uninstallName: null,
        uninstallResult: result
      })
      // 제거 뒤에는 목록을 새로 읽는다 (main 도 이미 새로 읽었지만 화면 상태를 맞춘다)
      void get().load(true)
    })
  },

  requestUninstall: async (programId) => {
    if (get().uninstallPhase !== 'idle') return
    set({ uninstallPhase: 'planning', uninstallError: null, uninstallResult: null })
    const r = await window.api.programs.uninstallPlan({ programId })
    if (r.ok) set({ uninstallPhase: 'confirming', uninstallPlan: r.data })
    else set({ uninstallPhase: 'idle', uninstallPlan: null, uninstallError: r.message })
  },
  cancelUninstall: () => {
    if (get().uninstallPhase !== 'confirming') return
    set({ uninstallPhase: 'idle', uninstallPlan: null })
  },
  confirmUninstall: async (acknowledgeCaution) => {
    const plan = get().uninstallPlan
    if (get().uninstallPhase !== 'confirming' || !plan) return
    const r = await window.api.programs.uninstall({
      programId: plan.programId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution
    })
    if (r.ok) set({ uninstallPhase: 'running', uninstallName: plan.name, uninstallPlan: null })
    else set({ uninstallPhase: 'idle', uninstallPlan: null, uninstallError: r.message })
  },
  dismissUninstallResult: () => set({ uninstallResult: null, uninstallError: null })
}))
