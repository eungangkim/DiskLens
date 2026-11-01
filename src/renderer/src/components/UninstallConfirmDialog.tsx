import { useEffect, useRef, useState } from 'react'
import type { UninstallPlan } from '@shared/uninstall'
import { formatBytes } from '../lib/format'

interface Props {
  plan: UninstallPlan
  onCancel: () => void
  onConfirm: (acknowledgeCaution: boolean) => void
}

/**
 * 프로그램 제거 확인 대화상자 (UI_SPEC.md §5.3, SAFETY.md §6).
 * 앱이 직접 파일을 지우지 않고 그 프로그램의 공식 제거 프로그램을 실행한다는 점을 알리고, 기본 포커스는 "취소"에 둔다.
 */
export function UninstallConfirmDialog({ plan, onCancel, onConfirm }: Props) {
  const [ack, setAck] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const ready = !plan.needsCautionAck || ack

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key !== 'Tab') return
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
        className="modal confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uninstall-title"
        ref={dialogRef}
        data-testid="uninstall-dialog"
      >
        <div className="modal-head">
          <h2 id="uninstall-title">프로그램 제거 확인</h2>
        </div>

        <div className="confirm-body">
          <p className="confirm-summary">
            <strong>{plan.name}</strong>을(를) 제거할까요?
          </p>
          <dl className="kv">
            <dt>게시자</dt>
            <dd>{plan.publisher ?? '—'}</dd>
            <dt>버전</dt>
            <dd>{plan.version ?? '—'}</dd>
            <dt>크기</dt>
            <dd>{plan.sizeBytes !== undefined ? formatBytes(plan.sizeBytes) : '—'}</dd>
            <dt>실행할 제거 프로그램</dt>
            <dd>{plan.installerName}</dd>
          </dl>

          {plan.warnings.length > 0 && (
            <div className="confirm-warn" role="note">
              <h3>⚠ 주의</h3>
              <ul>
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {plan.needsCautionAck && (
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  위 주의 사항을 읽었고 이해했습니다
                </label>
              )}
            </div>
          )}

          <p className="confirm-note" role="note">
            이 프로그램의 <strong>공식 제거 프로그램</strong>을 실행합니다. 제거 창이 나타나면
            안내에 따라 진행하세요. 관리자 권한이 필요하면 Windows 권한 확인 창(UAC)이 나타납니다.
            앱이 폴더나 레지스트리를 직접 지우지는 않습니다.
          </p>
        </div>

        <div className="confirm-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            취소
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!ready}
            onClick={() => onConfirm(ack)}
          >
            제거 프로그램 실행
          </button>
        </div>
      </div>
    </div>
  )
}
