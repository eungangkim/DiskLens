import { useCleanupStore } from '../store/cleanupStore'
import { useScanStore } from '../store/scanStore'
import { formatBytes, formatDuration, formatNumber, shortenPath } from '../lib/format'

/** 전역 하단 상태바: 어느 탭에서도 진행 중인 작업과 취소 버튼을 보여준다 (UI_SPEC.md §1) */
export function StatusBar() {
  const scanning = useScanStore((s) => s.scanning)
  const progress = useScanStore((s) => s.progress)
  const cancel = useScanStore((s) => s.cancelScan)
  const notice = useScanStore((s) => s.notice)
  const setNotice = useScanStore((s) => s.setNotice)
  const cleaning = useCleanupStore((s) => s.phase === 'running')
  const cleanProgress = useCleanupStore((s) => s.progress)
  const cancelClean = useCleanupStore((s) => s.cancelRun)

  return (
    <footer className="statusbar">
      {scanning ? (
        <>
          <span className="spinner" aria-hidden="true" />
          <span>
            스캔 중 · 파일 {formatNumber(progress?.filesScanned ?? 0)}개 ·{' '}
            {formatBytes(progress?.bytesScanned ?? 0)} · {formatDuration(progress?.elapsedMs ?? 0)}
          </span>
          <span className="muted ellipsis" title={progress?.currentPath}>
            {shortenPath(progress?.currentPath ?? '', 60)}
          </span>
          <button type="button" className="btn small" onClick={() => void cancel()}>
            취소
          </button>
        </>
      ) : cleaning ? (
        <>
          <span className="spinner" aria-hidden="true" />
          <span>
            정리 중 · 파일 {formatNumber(cleanProgress?.processedFiles ?? 0)}개 ·{' '}
            {formatBytes(cleanProgress?.freedBytes ?? 0)} 확보
          </span>
          <button type="button" className="btn small" onClick={() => void cancelClean()}>
            취소
          </button>
        </>
      ) : (
        <span className="muted">대기 중</span>
      )}
      {notice && (
        <span
          className={notice.kind === 'error' ? 'notice notice-error' : 'notice'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
          <button
            type="button"
            className="link"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
          >
            ✕
          </button>
        </span>
      )}
    </footer>
  )
}
