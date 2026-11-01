import { useScanStore } from '../store/scanStore'
import { formatBytes, formatPercent } from '../lib/format'

/** 상단바: 드라이브 사용량 막대 (UI_SPEC.md §1) */
export function TopBar() {
  const drive = useScanStore((s) => s.drive)
  const label = drive ? drive.root.slice(0, 2) : 'C:'
  const used = drive ? drive.totalBytes - drive.freeBytes : 0
  const ratio = drive && drive.totalBytes > 0 ? used / drive.totalBytes : 0

  return (
    <header className="topbar">
      <strong className="logo">DiskLens</strong>
      <div className="drive" aria-label="드라이브 사용량">
        {drive ? (
          <>
            <span>
              {label} {formatBytes(drive.totalBytes)} 중 {formatBytes(used)} 사용 (
              {formatPercent(ratio)})
            </span>
            <div
              className="bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
            >
              <div className="bar-fill" style={{ width: `${ratio * 100}%` }} />
            </div>
          </>
        ) : (
          <span className="muted">드라이브 정보를 읽는 중…</span>
        )}
      </div>
    </header>
  )
}
