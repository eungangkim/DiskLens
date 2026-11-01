import { useState } from 'react'
import { isFiltering, useScanStore } from '../store/scanStore'
import type { ScanTab } from '../store/scanStore'
import { FolderTree } from './scan/FolderTree'
import { FilterBar } from './scan/FilterBar'
import { TopList } from './scan/TopList'
import { TypesView } from './scan/TypesView'
import { DetailPanel } from './scan/DetailPanel'
import { SkippedModal } from './scan/SkippedModal'
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  shortenPath
} from '../lib/format'

const TABS: Array<{ id: ScanTab; label: string }> = [
  { id: 'tree', label: '폴더 트리' },
  { id: 'topFiles', label: '큰 파일 Top' },
  { id: 'topFolders', label: '큰 폴더 Top' },
  { id: 'types', label: '유형별 요약' }
]

export function ScanScreen() {
  const s = useScanStore()
  const [showSkipped, setShowSkipped] = useState(false)
  const root = s.summary?.root ?? s.drive?.root ?? 'C:\\'
  const driveLetter = root.slice(0, 2)

  // 빈 상태: 아직 스캔한 기록이 없고 스캔 중도 아닐 때 (UI_SPEC.md §2.4)
  if (!s.summary && !s.scanning) {
    return (
      <div className="empty-state">
        <p>아직 스캔한 기록이 없습니다.</p>
        <button type="button" className="btn primary big" onClick={() => void s.startScan()}>
          {driveLetter} 드라이브 스캔 시작
        </button>
        <p className="muted">스캔 대상: {root} · 파일을 읽기만 하며 아무것도 지우지 않습니다.</p>
      </div>
    )
  }

  const filtering = isFiltering(s.filter)
  const used = s.drive ? s.drive.totalBytes - s.drive.freeBytes : 0
  const wholeDrive = /^[a-z]:\\?$/i.test(s.drive?.root ?? '')
  const estimate =
    s.progress && wholeDrive && used > 0 ? Math.min(1, s.progress.bytesScanned / used) : null

  return (
    <div className="scan-screen">
      <section className="scan-top" aria-label="스캔 제어">
        <div className="scan-top-row">
          <button
            type="button"
            className="btn primary"
            disabled={s.scanning}
            onClick={() => void s.startScan()}
          >
            {s.summary ? '다시 스캔' : '스캔 시작'}
          </button>
          <span>
            스캔 루트: <strong>{root}</strong>
          </span>
          {s.summary && (
            <span className="muted">
              마지막 스캔: {formatDateTime(s.summary.finishedAt)}
              {s.fromCache ? ' (캐시)' : ''}
            </span>
          )}
          {s.summary && (
            <span className="muted">
              총 {formatBytes(s.summary.totalBytes)} · 파일 {formatNumber(s.summary.totalFiles)}개 ·
              폴더 {formatNumber(s.summary.totalDirs)}개
            </span>
          )}
          {s.summary && s.summary.skippedCount > 0 && (
            <span>
              접근 불가 {formatNumber(s.summary.skippedCount)}개{' '}
              <button type="button" className="link" onClick={() => setShowSkipped(true)}>
                [보기]
              </button>
            </span>
          )}
        </div>

        {s.scanning && (
          <div className="progress-panel" role="status" aria-live="polite">
            <div className="progress-stats">
              <span>파일 {formatNumber(s.progress?.filesScanned ?? 0)}개</span>
              <span>누적 {formatBytes(s.progress?.bytesScanned ?? 0)}</span>
              <span>경과 {formatDuration(s.progress?.elapsedMs ?? 0)}</span>
              <span>건너뜀 {formatNumber(s.progress?.skippedCount ?? 0)}개</span>
              <button type="button" className="btn small" onClick={() => void s.cancelScan()}>
                취소
              </button>
            </div>
            <div
              className="bar"
              role="progressbar"
              aria-label="스캔 진행률(추정)"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={estimate === null ? undefined : Math.round(estimate * 100)}
            >
              <div
                className={estimate === null ? 'bar-fill indeterminate' : 'bar-fill'}
                style={estimate === null ? undefined : { width: `${estimate * 100}%` }}
              />
            </div>
            <div className="muted ellipsis" title={s.progress?.currentPath}>
              {shortenPath(s.progress?.currentPath ?? '', 100)}
            </div>
          </div>
        )}
      </section>

      <nav className="tabs" role="tablist" aria-label="스캔 결과 보기">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={s.tab === t.id}
            className={s.tab === t.id ? 'tab active' : 'tab'}
            onClick={() => void s.setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="scan-body">
        <div className="scan-main" role="tabpanel">
          {!s.summary ? (
            <p className="empty">스캔이 끝나면 결과가 여기에 표시됩니다.</p>
          ) : s.tab === 'tree' ? (
            <>
              <FilterBar key={s.summary.scanId} />
              {filtering ? (
                <>
                  <p className="muted filter-note">
                    조건에 맞는 폴더를 큰 순으로 보여 줍니다 (최대 300개).
                  </p>
                  <TopList kind="folders" items={s.found} />
                </>
              ) : (
                <FolderTree />
              )}
            </>
          ) : s.tab === 'topFiles' ? (
            <TopList kind="files" items={s.topFiles} />
          ) : s.tab === 'topFolders' ? (
            <TopList kind="folders" items={s.topFolders} />
          ) : (
            <TypesView types={s.types} />
          )}
        </div>
        <DetailPanel />
      </div>

      {showSkipped && <SkippedModal onClose={() => setShowSkipped(false)} />}
    </div>
  )
}
