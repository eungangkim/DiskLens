import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { StatusBar } from './components/StatusBar'
import { CleanupScreen } from './screens/CleanupScreen'
import { ProgramsScreen } from './screens/ProgramsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ScanScreen } from './screens/ScanScreen'
import { MENUS, useNavStore } from './store/navStore'
import { useCleanupStore } from './store/cleanupStore'
import { useSettingsStore } from './store/settingsStore'
import { HistoryScreen } from './screens/HistoryScreen'
import { useProgramsStore } from './store/programsStore'
import { useScanStore } from './store/scanStore'

export function App() {
  const active = useNavStore((n) => n.active)
  const setActive = useNavStore((n) => n.setActive)
  const current = MENUS.find((m) => m.id === active)
  const scanning = useScanStore((s) => s.scanning)
  // 용량 단위가 바뀌면 화면 전체를 새로 그린다 (formatBytes 의 기본 단위가 바뀌므로)
  const unit = useSettingsStore((s) => s.settings.sizeUnit)

  // 앱 시작 시 이벤트 구독 + 마지막 스캔 캐시 자동 로드 (탭 이동과 무관하게 한 번만)
  useEffect(() => {
    void useSettingsStore.getState().init()
    void useScanStore.getState().init()
    // 스캔 탭 상세 패널의 "프로그램 탭에서 보기"를 위해 설치 프로그램 목록도 미리 읽어 둔다
    void useProgramsStore.getState().load(false)
    // 정리 항목 목록·설정과 정리 진행/완료 이벤트 구독 (탭과 무관하게 한 번만)
    void useCleanupStore.getState().init()
    // 프로그램 제거 완료 이벤트 구독
    useProgramsStore.getState().initUninstall()
  }, [])

  return (
    <div className="app" key={unit}>
      <TopBar />
      <div className="body">
        <nav className="sidebar" aria-label="주 메뉴">
          {MENUS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === active ? 'menu active' : 'menu'}
              aria-current={m.id === active ? 'page' : undefined}
              onClick={() => setActive(m.id)}
            >
              <span aria-hidden="true">{m.icon}</span> {m.label}
              {m.id === 'scan' && scanning && <span className="dot" title="스캔 중" />}
            </button>
          ))}
        </nav>
        <main className="main">
          {active === 'scan' ? (
            <ScanScreen />
          ) : active === 'programs' ? (
            <ProgramsScreen />
          ) : active === 'cleanup' ? (
            <CleanupScreen />
          ) : active === 'history' ? (
            <HistoryScreen />
          ) : active === 'settings' ? (
            <SettingsScreen />
          ) : (
            <>
              <h1>{current?.label}</h1>
              <p>이 화면은 아직 구현되지 않았습니다.</p>
            </>
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
