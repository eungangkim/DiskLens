import { useEffect, useState } from 'react'
import type { CleanupItem, CleanupRecord } from '@shared/cleanup'
import { formatBytes, formatDateTime, formatNumber, SKIP_REASON_LABELS } from '../lib/format'

/** 기록 화면 (UI_SPEC §6): 정리 기록 목록 + 항목별 결과/건너뜀 사유. 프로그램 제거는 로그 파일에만 남는다 */
export function HistoryScreen() {
  const [records, setRecords] = useState<CleanupRecord[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [h, items] = await Promise.all([
        window.api.cleanup.history(),
        window.api.cleanup.items()
      ])
      if (h.ok) setRecords(h.data)
      else setError(h.message)
      if (items.ok) setNames(new Map(items.data.map((i: CleanupItem) => [i.itemId, i.name])))
    })()
  }, [])

  const total = records?.reduce((sum, r) => sum + r.freedBytes, 0) ?? 0

  return (
    <div className="history">
      <h1>기록</h1>
      <div className="filter-bar">
        <button
          type="button"
          className="btn"
          onClick={() => void window.api.app.openFolder({ target: 'logs' })}
        >
          로그 폴더 열기
        </button>
        {records && records.length > 0 && (
          <span className="muted">
            정리 {formatNumber(records.length)}회 · 확보 합계 {formatBytes(total)}
          </span>
        )}
      </div>
      {error ? (
        <p className="empty" role="alert">
          {error}
        </p>
      ) : !records ? (
        <p className="empty">기록을 읽는 중…</p>
      ) : records.length === 0 ? (
        <p className="empty" data-testid="history-empty">
          아직 정리 기록이 없습니다. 정리를 실행하면 여기에 남습니다.
        </p>
      ) : (
        <div className="toplist">
          <table>
            <thead>
              <tr>
                <th>날짜</th>
                <th>방식</th>
                <th className="num">확보 용량</th>
                <th>항목</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <HistoryRow
                  key={r.jobId}
                  record={r}
                  names={names}
                  open={openId === r.jobId}
                  onToggle={() => setOpenId(openId === r.jobId ? null : r.jobId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted filter-note">
        프로그램 제거 기록은 로그 폴더의 로그 파일에서 볼 수 있습니다.
      </p>
    </div>
  )
}

function HistoryRow(props: {
  record: CleanupRecord
  names: Map<string, string>
  open: boolean
  onToggle: () => void
}) {
  const { record: r, names } = props
  const label = (id: string): string => names.get(id) ?? id
  const summary = r.itemIds.slice(0, 2).map(label).join(', ')
  const more = r.itemIds.length > 2 ? ` 외 ${r.itemIds.length - 2}개` : ''
  return (
    <>
      <tr
        className={props.open ? 'selected' : undefined}
        data-testid="history-row"
        onClick={props.onToggle}
      >
        <td>
          <button
            type="button"
            className="link-btn"
            aria-expanded={props.open}
            onClick={(e) => {
              e.stopPropagation()
              props.onToggle()
            }}
          >
            {formatDateTime(r.at)}
          </button>
          {r.cancelled && <span className="muted"> (중단됨)</span>}
        </td>
        <td>{r.mode === 'permanent' ? '영구 삭제' : '휴지통'}</td>
        <td className="num">{formatBytes(r.freedBytes)}</td>
        <td className="c-desc">
          {summary}
          {more}
        </td>
      </tr>
      {props.open && (
        <tr data-testid="history-detail">
          <td colSpan={4}>
            {r.perItem ? (
              <ul className="confirm-items">
                {r.perItem.map((i) => (
                  <li key={i.itemId}>
                    <span>{label(i.itemId)}</span>
                    <span className="muted">
                      {formatNumber(i.deletedFiles)}개 · {formatBytes(i.freedBytes)}
                      {i.skipped.length > 0 &&
                        ` · 건너뜀 ${i.skipped
                          .map(
                            (s) =>
                              `${SKIP_REASON_LABELS[s.reason] ?? s.reason} ${formatNumber(s.count)}개`
                          )
                          .join(', ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">이전 버전에서 남긴 기록이라 항목별 결과가 없습니다.</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
