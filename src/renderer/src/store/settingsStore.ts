import { create } from 'zustand'
import type { AppInfo, AppSettings } from '@shared/ipc'
import { setDisplayUnit } from '../lib/format'
import { useCleanupStore } from './cleanupStore'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  allowPermanentDelete: false,
  sizeUnit: 'GiB',
  theme: 'system',
  scanRoot: null,
  excludePaths: []
}

interface SettingsState {
  settings: AppSettings
  info: AppInfo | null
  loaded: boolean
  /** 마지막 저장/불러오기 오류 (화면에 보여 준다) */
  error: string | null

  init: () => Promise<void>
  /** 일부 값만 바꿔 저장한다. 서버(main)가 다시 검증하며, 실패하면 기존 값을 유지하고 이유를 보여 준다 */
  update: (patch: Partial<AppSettings>) => Promise<boolean>
  clearError: () => void
}

/** 테마를 문서에 적용 ('system' 이면 속성을 지워 OS 설정을 따른다) */
export function applyTheme(theme: AppSettings['theme']): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

function apply(settings: AppSettings): void {
  setDisplayUnit(settings.sizeUnit)
  applyTheme(settings.theme)
  // 정리 확인 대화상자가 쓰는 "영구 삭제 허용" 값도 같은 곳에서 맞춘다
  useCleanupStore.setState({ allowPermanent: settings.allowPermanentDelete })
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_APP_SETTINGS,
  info: null,
  loaded: false,
  error: null,

  init: async () => {
    const [s, i] = await Promise.all([window.api.settings.get(), window.api.app.info()])
    if (s.ok) {
      apply(s.data)
      set({ settings: s.data, loaded: true })
    } else set({ loaded: true, error: s.message })
    if (i.ok) set({ info: i.data })
  },

  update: async (patch) => {
    const r = await window.api.settings.set({ ...get().settings, ...patch })
    if (r.ok) {
      apply(r.data)
      set({ settings: r.data, error: null })
      return true
    }
    set({ error: r.message })
    return false
  },
  clearError: () => set({ error: null })
}))
