import { useEffect } from 'react'
import type { InstalledProgram } from '@shared/types'
import { SafetyBadge } from '../components/SafetyBadge'
import { UninstallConfirmDialog } from '../components/UninstallConfirmDialog'
import { formatBytes, formatNumber } from '../lib/format'
import { useNavStore } from '../store/navStore'
import { visiblePrograms, type ProgramSort } from '../lib/programList'
import { resultTone, uninstallButtonState } from '../lib/uninstallView'
import { useProgramsStore } from '../store/programsStore'
import { useScanStore } from '../store/scanStore'

const SORTS: Array<{ id: ProgramSort; label: string }> = [
  { id: 'size', label: '크기순' },
  { id: 'name', label: '이름순' },
  { id: 'date', label: '설치일순' }
]

/** 안전도 의미(프로그램, UI_SPEC §5.1): safe/unknown → 제거 가능, caution → 다른 프로그램이 필요로 할 수 있음, protected → 제거 불가 */
const IMPACT_LABEL: Record<InstalledProgram['match']['safety'], string> = {
  safe: '제거 가능',
  unknown: '제거 가능',
  caution: '다른 프로그램이 필요로 할 수 있음',
  protected: '제거 불가'
}

/** 프로그램 화면 (UI_SPEC §5.1~5.3). 제거는 공식 제거 프로그램 실행만 한다 (SAFETY §6) */
export function ProgramsScreen() {
  const programs = useProgramsStore((s) => s.programs)
  const loading = useProgramsStore((s) => s.loading)
  const error = useProgramsStore((s) => s.error)
  const includeSystem = useProgramsStore((s) => s.includeSystem)
  const sort = useProgramsStore((s) => s.sort)
  const query = useProgramsStore((s) => s.query)
  const selectedId = useProgramsStore((s) => s.selectedId)
  const store = useProgramsStore.getState()
  const scanId = useScanStore((x) => x.summary?.scanId)
  const phase = useProgramsStore((s) => s.uninstallPhase)
  const plan = useProgramsStore((s) => s.uninstallPlan)

  // 스캔 결과가 바뀌면 설치 폴더 용량/연결을 다시 맞춘다 (첫 목록은 앱 시작 때 읽어 둔다)
  useEffect(() => {
    void useProgramsStore.getState().load(false)
  }, [])
  useEffect(() => {
    if (scanId) void useProgramsStore.getState().load(true)
  }, [scanId])

  const list = programs ? visiblePrograms(programs, { includeSystem, query, sort }) : null
  const selected = list?.find((p) => p.id === selectedId) ?? null
  const hiddenCount = programs ? programs.filter((p) => p.isSystemComponent).length : 0

  return (
    <div className="programs">
      <h1>프로그램</h1>
      <UninstallStatus />
      <div className="filter-bar" role="group" aria-label="프로그램 목록 옵션">
        <div className="seg" role="radiogroup" aria-label="정렬">
          {SORTS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={sort === o.id}
              className={sort === o.id ? 'seg-btn active' : 'seg-btn'}
              onClick={() => store.setSort(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={includeSystem}
            onChange={(e) => store.setIncludeSystem(e.target.checked)}
          />
          시스템 구성요소 표시 ({formatNumber(hiddenCount)}개)
        </label>
        <input
          type="search"
          className="search"
          placeholder="이름·게시자 검색"
          aria-label="프로그램 검색"
          maxLength={100}
          value={query}
          onChange={(e) => store.setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn small"
          disabled={loading}
          onClick={() => void store.load(true)}
        >
          {loading ? '읽는 중…' : '새로 고침'}
        </button>
      </div>

      <div className="scan-body">
        <div className="scan-main">
          {error ? (
            <p className="empty" role="alert">
              {error}
            </p>
          ) : !list ? (
            <p className="empty">설치된 프로그램을 읽는 중…</p>
          ) : list.length === 0 ? (
            <p className="empty">표시할 프로그램이 없습니다.</p>
          ) : (
            <ProgramTable
              list={list}
              selectedId={selectedId}
              busy={phase !== 'idle'}
              onSelect={store.select}
            />
          )}
          {list && (
            <p className="muted filter-note">
              {formatNumber(list.length)}개 표시
              {!includeSystem && hiddenCount > 0
                ? ` (시스템 구성요소 ${formatNumber(hiddenCount)}개 숨김)`
                : ''}
            </p>
          )}
        </div>
        <ProgramDetail program={selected} busy={phase !== 'idle'} />
      </div>
      {phase === 'confirming' && plan && (
        <UninstallConfirmDialog
          key={plan.confirmationId}
          plan={plan}
          onCancel={store.cancelUninstall}
          onConfirm={(ack) => void store.confirmUninstall(ack)}
        />
      )}
    </div>
  )
}

function ProgramTable(props: {
  list: InstalledProgram[]
  selectedId: string | null
  busy: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div className="toplist">
      <table>
        <colgroup>
          <col />
          <col style={{ width: 120 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 105 }} />
          <col style={{ width: 60 }} />
        </colgroup>
        <thead>
          <tr>
            <th>이름</th>
            <th>게시자</th>
            <th className="num">크기</th>
            <th>버전</th>
            <th>설치일</th>
            <th>안전도</th>
            <th>제거</th>
          </tr>
        </thead>
        <tbody>
          {props.list.map((p) => (
            <tr
              key={p.id}
              className={props.selectedId === p.id ? 'selected' : undefined}
              onClick={() => props.onSelect(p.id)}
            >
              <td className="c-desc" title={p.name}>
                {p.name}
              </td>
              <td className="c-desc" title={p.publisher}>
                {p.publisher ?? '—'}
              </td>
              <td className="num">
                {p.estimatedSizeBytes !== undefined ? formatBytes(p.estimatedSizeBytes) : '—'}
              </td>
              <td className="c-desc">{p.version ?? '—'}</td>
              <td>{p.installDate ?? '—'}</td>
              <td title={IMPACT_LABEL[p.match.safety]}>
                <SafetyBadge safety={p.match.safety} />
              </td>
              <td>
                <UninstallButton program={p} busy={props.busy} small />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProgramDetail({ program, busy }: { program: InstalledProgram | null; busy: boolean }) {
  const setActive = useNavStore((n) => n.setActive)
  const reveal = useScanStore((x) => x.reveal)

  if (!program) {
    return (
      <aside className="detail" aria-label="프로그램 상세">
        <p className="muted">프로그램을 선택하면 자세한 정보가 여기에 표시됩니다.</p>
      </aside>
    )
  }
  const m = program.match
  return (
    <aside className="detail" aria-label="프로그램 상세">
      <div className="detail-title">
        <h2 title={program.name}>{program.name}</h2>
        <SafetyBadge safety={m.safety} />
      </div>
      <dl className="kv">
        <dt>게시자</dt>
        <dd>{program.publisher ?? '—'}</dd>
        <dt>버전</dt>
        <dd>{program.version ?? '—'}</dd>
        <dt>크기</dt>
        <dd>
          {program.estimatedSizeBytes !== undefined
            ? `${formatBytes(program.estimatedSizeBytes)} (${program.sizeSource === 'scan' ? '스캔 결과' : '설치 정보'})`
            : '—'}
        </dd>
        <dt>설치 경로</dt>
        <dd className="path-break">{program.installLocation ?? '알 수 없음'}</dd>
      </dl>
      <div className="detail-actions">
        <button
          type="button"
          className="btn"
          disabled={!program.installLocation}
          onClick={() => void window.api.programs.openFolder({ programId: program.id })}
        >
          설치 폴더 열기
        </button>
        <button
          type="button"
          className="btn"
          disabled={!program.scanNode}
          title={program.scanNode ? undefined : '현재 스캔 결과에 이 폴더가 없습니다'}
          onClick={() => {
            if (!program.scanNode) return
            setActive('scan')
            void reveal(program.scanNode.scanId, program.scanNode.nodeId)
          }}
        >
          스캔 결과에서 보기
        </button>
        <UninstallButton program={program} busy={busy} />
      </div>
      <div className="rule-box">
        <h3>이게 뭔가요?</h3>
        <p>
          {m.description ??
            '설명 규칙이 없는 프로그램입니다. 직접 설치한 프로그램이라면 필요 없을 때 제거해도 됩니다.'}
        </p>
        {m.impact && (
          <>
            <h3>지우면?</h3>
            <p>{m.impact}</p>
          </>
        )}
        <p className="muted">
          {IMPACT_LABEL[m.safety]}
          {m.ruleId ? ` | 규칙: ${m.ruleId}` : ''}
        </p>
      </div>
    </aside>
  )
}

function UninstallButton(props: { program: InstalledProgram; busy: boolean; small?: boolean }) {
  const state = uninstallButtonState(props.program, props.busy)
  return (
    <button
      type="button"
      className={props.small ? 'btn small' : 'btn'}
      disabled={state.disabled}
      title={state.title}
      data-testid="uninstall-button"
      onClick={(e) => {
        e.stopPropagation() // 행 선택과 별개로 동작
        void useProgramsStore.getState().requestUninstall(props.program.id)
      }}
    >
      제거
    </button>
  )
}

/** 제거 진행 배너와 결과 안내 */
function UninstallStatus() {
  const phase = useProgramsStore((s) => s.uninstallPhase)
  const name = useProgramsStore((s) => s.uninstallName)
  const result = useProgramsStore((s) => s.uninstallResult)
  const error = useProgramsStore((s) => s.uninstallError)
  const dismiss = useProgramsStore((s) => s.dismissUninstallResult)
  const setActive = useNavStore((n) => n.setActive)
  const reveal = useScanStore((x) => x.reveal)

  if (phase === 'running') {
    return (
      <p className="notice-line" role="status" data-testid="uninstall-running">
        <span className="spinner" aria-hidden="true" /> {name ?? '프로그램'} 제거 프로그램이
        실행되었습니다. 완료될 때까지 기다리는 중…
      </p>
    )
  }
  if (error) {
    return (
      <p className="notice-line warn" role="alert" data-testid="uninstall-error">
        {error}{' '}
        <button type="button" className="btn small" onClick={dismiss}>
          닫기
        </button>
      </p>
    )
  }
  if (!result) return null
  return (
    <div
      className={`notice-line ${resultTone(result)}`}
      role="status"
      data-testid="uninstall-result"
    >
      <p>
        <strong>{result.name}</strong>: {result.message}
      </p>
      {result.rebootRequired && <p>변경을 마치려면 PC를 다시 시작해야 합니다.</p>}
      {result.leftover && (
        <p>
          제거 후 남은 폴더가 있을 수 있습니다:{' '}
          <span className="path-break" data-testid="uninstall-leftover">
            {result.leftover.path}
          </span>{' '}
          (앱은 이 폴더를 지우지 않습니다.)
          {result.leftover.scanNode && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                const node = result.leftover?.scanNode
                if (!node) return
                setActive('scan')
                void reveal(node.scanId, node.nodeId)
              }}
            >
              보기
            </button>
          )}
        </p>
      )}
      <button type="button" className="btn small" onClick={dismiss}>
        닫기
      </button>
    </div>
  )
}
