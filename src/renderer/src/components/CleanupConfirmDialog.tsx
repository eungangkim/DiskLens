import { useEffect, useRef, useState } from 'react'
import type { CleanupItem, CleanupMode, CleanupPlan } from '@shared/cleanup'
import { canConfirm, largestPaths, permanentAvailability } from '../lib/cleanupView'
import { formatBytes, formatNumber, shortenPath } from '../lib/format'

interface Props {
  plan: CleanupPlan
  items: CleanupItem[]
  allowPermanentSetting: boolean
  /** 삭제 방식을 바꾸면 새 계획(새 확인 토큰)이 필요하다 */
  onChangeMode: (mode: CleanupMode) => void
  onCancel: () => void
  onConfirm: (acknowledgeCaution: boolean) => void
}

/**
 * 정리 확인 대화상자 (UI_SPEC.md §2.3, SAFETY.md §9).
 * 항목 수·총 용량·방식·가장 큰 3개 경로·주의 문구를 보여 주고, 기본 포커스는 "취소"에 둔다.
 * 영구 삭제는 빨간 강조 + "되돌릴 수 없음" 체크 전에는 실행 버튼이 비활성이다. "다시 묻지 않기" 옵션은 없다.
 */
export function CleanupConfirmDialog(props: Props) {
  const { plan, items, allowPermanentSetting } = props
  const [cautionAck, setCautionAck] = useState(false)
  const [permanentAck, setPermanentAck] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const permanent = plan.mode === 'permanent'
  const byId = new Map(items.map((i) => [i.itemId, i]))
  const itemIds = plan.items.map((i) => i.itemId)
  const permanentCheck = permanentAvailability(items, itemIds, allowPermanentSetting)
  const cautionItems = plan.items.filter((i) => byId.get(i.itemId)?.safety === 'caution')
  const adminItems = plan.items.filter((i) => byId.get(i.itemId)?.requiresAdmin)
  const ready = canConfirm({ plan, permanent, cautionAck, permanentAck })

  // 열릴 때 항상 "취소"에 포커스를 둔다. 새 계획(삭제 방식 변경)이 되면 부모가 key 로 새로 마운트하므로
  // 확인 체크도 처음부터 다시 받고 포커스도 다시 취소로 돌아온다.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      props.onCancel()
      return
    }
    if (e.key !== 'Tab') return
    // 대화상자 밖으로 포커스가 나가지 않게 가둔다
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
    if (!nodes || nodes.length === 0) return
    const first = nodes[0] as HTMLElement
    const last = nodes[nodes.length - 1] as HTMLElement
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className={permanent ? 'modal confirm danger' : 'modal confirm'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 id="confirm-title">{permanent ? '영구 삭제 확인' : '정리 실행 확인'}</h2>
        </div>

        <p className="confirm-summary">
          항목 <strong>{formatNumber(plan.items.length)}개</strong> · 파일{' '}
          <strong>{formatNumber(plan.totalFiles)}개</strong> · 총{' '}
          <strong>{formatBytes(plan.totalBytes)}</strong>
        </p>

        <fieldset className="confirm-mode">
          <legend>삭제 방식</legend>
          <label className="check">
            <input
              type="radio"
              name="cleanup-mode"
              checked={!permanent}
              onChange={() => props.onChangeMode('trash')}
            />
            휴지통으로 이동 (되돌릴 수 있음)
          </label>
          <label className="check">
            <input
              type="radio"
              name="cleanup-mode"
              checked={permanent}
              disabled={!permanentCheck.ok}
              onChange={() => props.onChangeMode('permanent')}
            />
            영구 삭제
          </label>
          {!permanentCheck.ok && <p className="muted small">{permanentCheck.reason}</p>}
        </fieldset>

        <div className="confirm-body">
          <h3>정리할 항목</h3>
          <ul className="confirm-items">
            {plan.items.map((i) => (
              <li key={i.itemId}>
                <span>{byId.get(i.itemId)?.name ?? i.itemId}</span>
                <span className="muted">
                  {formatNumber(i.fileCount)}개 · {formatBytes(i.bytes)}
                </span>
              </li>
            ))}
          </ul>

          {largestPaths(plan).length > 0 && (
            <>
              <h3>가장 큰 대상</h3>
              <ul className="confirm-paths">
                {largestPaths(plan).map((p) => (
                  <li key={p} title={p}>
                    {shortenPath(p, 90)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {cautionItems.length > 0 && (
            <div className="confirm-warn" role="note">
              <h3>⚠ 주의 항목</h3>
              <ul>
                {cautionItems.map((i) => (
                  <li key={i.itemId}>
                    <strong>{byId.get(i.itemId)?.name}</strong>: {byId.get(i.itemId)?.impact}
                  </li>
                ))}
              </ul>
              <label className="check">
                <input
                  type="checkbox"
                  checked={cautionAck}
                  onChange={(e) => setCautionAck(e.target.checked)}
                />
                위 주의 사항을 읽었고 이해했습니다
              </label>
            </div>
          )}

          {adminItems.length > 0 && (
            <p className="confirm-note" role="note">
              🛡 관리자 권한이 필요한 항목({adminItems.length}개)이 있어 실행하면 Windows 권한 확인
              창(UAC)이 나타납니다. 거부하면 이 항목만 건너뛰고 나머지는 그대로 진행합니다.
            </p>
          )}

          {!permanent && (
            <p className="muted">
              휴지통으로 옮긴 파일은 <strong>휴지통을 비워야</strong> 실제 용량이 늘어납니다.
            </p>
          )}

          {permanent && (
            <div className="confirm-danger" role="alert">
              <strong>되돌릴 수 없습니다.</strong> 영구 삭제한 파일은 휴지통에서도 복구할 수
              없습니다.
              <label className="check">
                <input
                  type="checkbox"
                  checked={permanentAck}
                  onChange={(e) => setPermanentAck(e.target.checked)}
                />
                되돌릴 수 없음을 이해했습니다
              </label>
            </div>
          )}

          {plan.totalFiles === 0 && (
            <p className="muted" role="status">
              지금 정리할 파일이 없습니다.
            </p>
          )}
        </div>

        <div className="confirm-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={props.onCancel}>
            취소
          </button>
          <button
            type="button"
            className={permanent ? 'btn danger' : 'btn primary'}
            disabled={!ready}
            onClick={() => props.onConfirm(cautionAck)}
          >
            {permanent ? '영구 삭제' : '휴지통으로 이동'}
          </button>
        </div>
      </div>
    </div>
  )
}
