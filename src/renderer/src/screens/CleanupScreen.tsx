import { useEffect } from 'react'
import type { CleanupItem } from '@shared/cleanup'
import { CleanupConfirmDialog } from '../components/CleanupConfirmDialog'
import { SafetyBadge } from '../components/SafetyBadge'
import {
  IDLE_ANALYSIS,
  analysisTotal,
  groupItems,
  isSelectable,
  selectionTotals,
  summarizeSkips,
  type ItemAnalysis
} from '../lib/cleanupView'
import { formatBytes, formatNumber, shortenPath } from '../lib/format'
import { useCleanupStore } from '../store/cleanupStore'
import { useNavStore } from '../store/navStore'
import { useScanStore } from '../store/scanStore'

/** 정리 화면 (UI_SPEC.md §4). 분석(삭제 없음) → 선택 → 확인 대화상자 → 실행 → 결과 */
export function CleanupScreen() {
  const s = useCleanupStore()
  const { items, phase, selected, analysis } = s

  // 스캔 상세의 "이 항목 정리하기"로 들어왔으면 바로 확인 단계로 간다
  useEffect(() => {
    const st = useCleanupStore.getState()
    if (!st.items || !st.pendingItemId || st.phase !== 'idle') return
    const id = st.pendingItemId
    useCleanupStore.setState({ pendingItemId: null })
    if (st.items.some((i) => i.itemId === id && isSelectable(i))) {
      useCleanupStore.setState({ detailId: id })
      void st.openConfirm([id], 'trash')
    }
  }, [items, s.pendingItemId, phase])

  if (phase === 'result' && s.result) return <ResultView />
  if (phase === 'running') return <RunningView />

  const busy = phase !== 'idle'
  const groups = items ? groupItems(items) : []
  const totals = selectionTotals(selected, analysis)
  const analyzedAny = Object.values(analysis).some((a) => a.status === 'done')
  const allSelectedAnalyzed = selected.size > 0 && totals.analyzed === selected.size
  const detail = items?.find((i) => i.itemId === s.detailId) ?? null

  return (
    <div className="cleanup">
      <h1>정리</h1>
      <p className="muted" data-testid="cleanup-summary">
        {items
          ? `정리 가능한 항목 ${formatNumber(items.length)}개${
              analyzedAny
                ? `, 예상 확보 약 ${formatBytes(analysisTotal(analysis))}`
                : ' (분석 후 예상 용량이 표시됩니다)'
            }`
          : '항목을 불러오는 중…'}
      </p>

      <div className="cleanup-actions">
        <button
          type="button"
          className="btn primary big"
          disabled={busy || !items}
          onClick={() => void s.oneClick()}
        >
          원클릭 안전 정리
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !items}
          onClick={() => void s.analyzeAll()}
        >
          {phase === 'analyzing' ? '분석 중…' : '분석하기'}
        </button>
        <button type="button" className="btn" disabled={busy || !items} onClick={s.selectSafe}>
          안전 항목만 선택
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !allSelectedAnalyzed}
          title={allSelectedAnalyzed ? undefined : '먼저 [분석하기]를 하고 항목을 선택하세요'}
          onClick={() => void s.openConfirm([...selected])}
        >
          선택 항목 정리 ({selected.size})
        </button>
        {selected.size > 0 && (
          <span className="muted" data-testid="selection-total">
            선택 {formatNumber(selected.size)}개
            {totals.analyzed > 0
              ? ` · ${formatNumber(totals.fileCount)}개 파일 · ${formatBytes(totals.bytes)}`
              : ''}
          </span>
        )}
      </div>

      {s.planError && (
        <p className="notice notice-error" role="alert">
          {s.planError}
        </p>
      )}
      {s.loadError && (
        <p className="empty" role="alert">
          {s.loadError}
        </p>
      )}

      <div className="scan-body">
        <div className="scan-main cleanup-list">
          {groups.map((g) => (
            <details key={g.group} open className="cleanup-group">
              <summary>
                {g.group} <span className="muted">({g.items.length})</span>
              </summary>
              {g.items.map((item) => (
                <ItemRow
                  key={item.itemId}
                  item={item}
                  checked={selected.has(item.itemId)}
                  analysis={analysis[item.itemId] ?? IDLE_ANALYSIS}
                  active={s.detailId === item.itemId}
                  disabled={busy}
                />
              ))}
            </details>
          ))}
        </div>
        <ItemDetail
          item={detail}
          analysis={detail ? (analysis[detail.itemId] ?? IDLE_ANALYSIS) : null}
        />
      </div>

      {phase === 'confirm' && s.plan && items && (
        <CleanupConfirmDialog
          key={s.plan.planId}
          plan={s.plan}
          items={items}
          allowPermanentSetting={s.allowPermanent}
          onChangeMode={(mode) =>
            void s.openConfirm(s.plan?.items.map((i) => i.itemId) ?? [], mode)
          }
          onCancel={s.cancelConfirm}
          onConfirm={(ack) => void s.run(ack)}
        />
      )}
    </div>
  )
}

function ItemRow(props: {
  item: CleanupItem
  checked: boolean
  analysis: ItemAnalysis
  active: boolean
  disabled: boolean
}) {
  const { item, analysis } = props
  const store = useCleanupStore.getState()
  const selectable = isSelectable(item)
  return (
    <div className={props.active ? 'cleanup-row active' : 'cleanup-row'} data-item={item.itemId}>
      <div className="cleanup-row-main">
        <input
          type="checkbox"
          aria-label={`${item.name} 선택`}
          checked={props.checked}
          disabled={props.disabled || !selectable}
          onChange={() => store.toggle(item.itemId)}
        />
        <button
          type="button"
          className="link cleanup-name"
          onClick={() => store.showDetail(item.itemId)}
          title={item.description}
        >
          {item.name}
        </button>
        <SafetyBadge safety={item.safety} />
        <span className="cleanup-desc muted ellipsis" title={item.description}>
          {item.description}
        </span>
        <span className="cleanup-size num">
          {analysis.status === 'running' ? (
            <span className="spinner" role="status" aria-label="분석 중" />
          ) : analysis.status === 'done' ? (
            <>
              {formatBytes(analysis.bytes)}
              <span className="muted"> · {formatNumber(analysis.fileCount)}개</span>
            </>
          ) : (
            '—'
          )}
        </span>
        <span className="cleanup-tags">
          {item.requiresAdmin && (
            <span className="tag" title="실행하면 Windows 권한 확인 창(UAC)이 나타납니다">
              관리자 필요
            </span>
          )}
          {!selectable && <span className="tag">다음 단계에서 지원</span>}
          {item.needsProcessClosed && (
            <span
              className="tag"
              title={`${item.needsProcessClosed.join(', ')} 실행 중이면 일부 건너뜀`}
            >
              ⚠ {item.needsProcessClosed[0]} 종료 권장
            </span>
          )}
        </span>
      </div>
      {props.checked && item.safety === 'caution' && (
        <p className="cleanup-caution" role="note">
          ⚠ {item.impact}
        </p>
      )}
    </div>
  )
}

function ItemDetail({
  item,
  analysis
}: {
  item: CleanupItem | null
  analysis: ItemAnalysis | null
}) {
  if (!item) {
    return (
      <aside className="detail" aria-label="항목 상세">
        <p className="muted">항목 이름을 누르면 자세한 정보가 여기에 표시됩니다.</p>
      </aside>
    )
  }
  return (
    <aside className="detail" aria-label="항목 상세">
      <div className="detail-title">
        <h2 title={item.name}>{item.name}</h2>
        <SafetyBadge safety={item.safety} />
      </div>
      <div className="rule-box">
        <h3>이게 뭔가요?</h3>
        <p>{item.description}</p>
        <h3>지우면?</h3>
        <p>{item.impact}</p>
        {analysis?.status === 'done' && (
          <>
            <h3>대상 경로 (큰 순 최대 3개)</h3>
            {analysis.sample.length === 0 ? (
              <p className="muted">지금 정리할 파일이 없습니다.</p>
            ) : (
              <ul className="confirm-paths">
                {analysis.sample.map((p) => (
                  <li key={p} title={p}>
                    {shortenPath(p, 60)}
                  </li>
                ))}
              </ul>
            )}
            {analysis.warnings.map((w) => (
              <p key={w} className="muted">
                {w}
              </p>
            ))}
          </>
        )}
        <p className="muted">
          {item.allowPermanent
            ? '영구 삭제 선택 가능(설정에서 허용 시)'
            : '휴지통으로만 이동합니다'}
        </p>
      </div>
    </aside>
  )
}

/** 실행 중: 진행 패널 + 취소 (UI_SPEC §4.3-4) */
function RunningView() {
  const progress = useCleanupStore((s) => s.progress)
  const items = useCleanupStore((s) => s.items)
  const cancelRun = useCleanupStore((s) => s.cancelRun)
  const current = items?.find((i) => i.itemId === progress?.itemId)
  const name = current?.name
  return (
    <div className="cleanup">
      <h1>정리</h1>
      <div
        className="progress-panel"
        role="status"
        aria-live="polite"
        data-testid="cleanup-running"
      >
        <span className="spinner" aria-hidden="true" />
        <p>정리하는 중… {name ? `(${name})` : ''}</p>
        {current?.requiresAdmin && (
          <p className="muted">
            Windows 권한 확인 창이 떴다면 [예]를 눌러 허용하세요. 거부하면 이 항목만 건너뜁니다.
          </p>
        )}
        <p className="muted">
          처리한 파일 {formatNumber(progress?.processedFiles ?? 0)}개 · 확보한 용량{' '}
          {formatBytes(progress?.freedBytes ?? 0)}
        </p>
        {progress?.currentPath && (
          <p className="muted ellipsis" title={progress.currentPath}>
            {shortenPath(progress.currentPath, 80)}
          </p>
        )}
        <button type="button" className="btn" onClick={() => void cancelRun()}>
          취소
        </button>
      </div>
    </div>
  )
}

/** 결과 화면 (UI_SPEC §4.3-5) */
function ResultView() {
  const result = useCleanupStore((s) => s.result)
  const items = useCleanupStore((s) => s.items)
  const dismiss = useCleanupStore((s) => s.dismissResult)
  const setActive = useNavStore((n) => n.setActive)
  const startScan = useScanStore((s) => s.startScan)
  if (!result) return null
  const skips = summarizeSkips(result.perItem)
  const nameOf = (id: string): string => items?.find((i) => i.itemId === id)?.name ?? id
  return (
    <div className="cleanup" data-testid="cleanup-result">
      <h1>정리 결과</h1>
      {result.cancelled && (
        <p className="notice">정리를 중간에 멈췄습니다. 이미 지운 것은 그대로입니다.</p>
      )}
      {result.error && (
        <p className="notice notice-error" role="alert">
          {result.error}
        </p>
      )}
      <p className="result-summary">
        확보한 용량 <strong>{formatBytes(result.freedBytes)}</strong> · 삭제{' '}
        <strong>{formatNumber(result.deletedFiles)}개</strong> · 건너뜀{' '}
        <strong>{formatNumber(result.skippedFiles)}개</strong>
      </p>
      {result.mode === 'trash' && result.deletedFiles > 0 && (
        <p className="muted">
          휴지통으로 옮겼습니다. <strong>휴지통을 비워야</strong> 실제 디스크 용량이 늘어납니다.
        </p>
      )}
      {skips.length > 0 && (
        <>
          <h3>건너뜀 사유</h3>
          <ul className="skipped-list">
            {skips.map((k) => (
              <li key={k.reason}>
                <span>{k.label}</span>
                <span className="muted">{formatNumber(k.count)}개</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>항목별</h3>
      <ul className="skipped-list">
        {result.perItem.map((i) => (
          <li key={i.itemId}>
            <span>{nameOf(i.itemId)}</span>
            <span className="muted">
              {formatNumber(i.deletedFiles)}개 · {formatBytes(i.freedBytes)}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">정리 기록에 저장했습니다.</p>
      <div className="cleanup-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            dismiss()
            setActive('scan')
            void startScan()
          }}
        >
          다시 스캔하기
        </button>
        <button type="button" className="btn" onClick={dismiss}>
          닫기
        </button>
      </div>
    </div>
  )
}
