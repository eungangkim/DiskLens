import { useEffect, useRef, useState } from 'react'
import type { SkippedResponse } from '@shared/ipc'
import { useScanStore } from '../../store/scanStore'
import { formatNumber, SKIP_REASON_LABELS } from '../../lib/format'

/** 건너뜀 목록 모달. 권한 오류는 "오류"가 아니라 "건너뜀"으로 보여준다 (UI_SPEC.md §2.4) */
export function SkippedModal({ onClose }: { onClose: () => void }) {
  const summary = useScanStore((s) => s.summary)
  const [data, setData] = useState<SkippedResponse | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!summary) return
    void window.api.scan.getSkipped({ scanId: summary.scanId }).then((r) => {
      if (r.ok) setData(r.data)
    })
    closeRef.current?.focus()
  }, [summary])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="건너뛴 항목"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-head">
          <h2>건너뛴 항목 {data ? formatNumber(data.total) : ''}개</h2>
          <button ref={closeRef} type="button" className="btn small" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="muted">
          권한이 없거나 사용 중이라 읽지 못한 폴더/파일입니다. 용량 합계에는 포함되지 않아 탐색기
          값과 조금 다를 수 있습니다.
          {data &&
            data.total > data.items.length &&
            ` (처음 ${formatNumber(data.items.length)}개만 표시)`}
        </p>
        <ul className="skipped-list">
          {(data?.items ?? []).map((it, i) => (
            <li key={i}>
              <span className="skip-reason">{SKIP_REASON_LABELS[it.reason] ?? it.reason}</span>
              <span className="path-break">{it.path}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
