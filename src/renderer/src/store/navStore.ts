import { create } from 'zustand'

export const MENUS = [
  { id: 'scan', icon: '📊', label: '스캔' },
  { id: 'cleanup', icon: '🧹', label: '정리' },
  { id: 'programs', icon: '📦', label: '프로그램' },
  { id: 'history', icon: '📜', label: '기록' },
  { id: 'settings', icon: '⚙', label: '설정' }
] as const

export type MenuId = (typeof MENUS)[number]['id']

interface NavState {
  active: MenuId
  setActive: (id: MenuId) => void
}

/** 사이드바 메뉴 상태. 화면끼리 이동(스캔 ↔ 프로그램)할 때도 이 스토어를 쓴다 */
export const useNavStore = create<NavState>((set) => ({
  active: 'scan',
  setActive: (active) => set({ active })
}))
