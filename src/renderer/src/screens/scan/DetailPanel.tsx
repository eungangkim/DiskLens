import type { RuleMatch } from '@shared/types'
import { findProgramForPath } from '../../lib/programLink'
import { useNavStore } from '../../store/navStore'
import { useCleanupStore } from '../../store/cleanupStore'
import { useProgramsStore } from '../../store/programsStore'
import { useScanStore } from '../../store/scanStore'
import { SafetyBadge } from '../../components/SafetyBadge'
import { formatBytes, formatDateTime, formatNumber, formatPercent } from '../../lib/format'

/**
 * 우측 상세 패널 (UI_SPEC.md §3.4).
 * 규칙 DB의 설명·안전도를 보여 준다. 정리 가능한 safe/caution 항목에만 "이 항목 정리하기"가 보인다.
 */
export function DetailPanel() {
  const selected = useScanStore((s) => s.selected)
  const showInExplorer = useScanStore((s) => s.showInExplorer)
  const copyPath = useScanStore((s) => s.copyPath)

  if (!selected) {
    return (
      <aside className="detail" aria-label="상세 정보">
        <p className="muted">항목을 선택하면 자세한 정보가 여기에 표시됩니다.</p>
      </aside>
    )
  }

  const synthetic = selected.kind === 'collapsed'
  return (
    <aside className="detail" aria-label="상세 정보">
      <div className="detail-title">
        <h2 title={selected.name}>{selected.name}</h2>
        <SafetyBadge safety={selected.match.safety} />
      </div>

      <dl className="kv">
        <dt>경로</dt>
        <dd className="path-break">{selected.path}</dd>
        <dt>크기</dt>
        <dd>
          {formatBytes(selected.size)} (전체의 {formatPercent(selected.percentOfTotal)})
        </dd>
        {selected.fileCount !== undefined && (
          <>
            <dt>파일 수</dt>
            <dd>{formatNumber(selected.fileCount)}개</dd>
          </>
        )}
        {selected.modifiedAt && (
          <>
            <dt>수정일</dt>
            <dd>{formatDateTime(selected.modifiedAt)}</dd>
          </>
        )}
      </dl>

      <div className="detail-actions">
        <button type="button" className="btn" onClick={() => void showInExplorer(selected)}>
          탐색기에서 열기
        </button>
        <button type="button" className="btn" onClick={() => void copyPath(selected)}>
          경로 복사
        </button>
      </div>

      {synthetic && (
        <p className="muted">
          여러 항목을 합친 줄입니다. 위 경로는 이 항목이 들어 있는 폴더입니다.
        </p>
      )}
      {selected.isLink && (
        <p className="muted">
          다른 위치를 가리키는 링크 폴더입니다. 이중 집계를 피하려고 용량에 포함하지 않았습니다.
        </p>
      )}

      <ProgramHint path={selected.path} />
      <RuleInfo match={selected.match} />
    </aside>
  )
}

/** 이 폴더가 설치된 프로그램의 폴더(또는 그 하위)이면 알려 주고 프로그램 탭으로 이동할 수 있게 한다 */
function ProgramHint({ path }: { path: string }) {
  const programs = useProgramsStore((s) => s.programs)
  const select = useProgramsStore((s) => s.select)
  const setActive = useNavStore((n) => n.setActive)
  const program = programs ? findProgramForPath(programs, path) : null
  if (!program) return null
  return (
    <div className="program-hint">
      <p>
        📦 설치된 프로그램 <strong>{program.name}</strong>의 폴더입니다.
      </p>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          // 시스템 구성요소가 숨겨져 있으면 선택한 프로그램이 안 보이므로 함께 켠다
          if (program.isSystemComponent) useProgramsStore.getState().setIncludeSystem(true)
          useProgramsStore.getState().setQuery('')
          select(program.id)
          setActive('programs')
        }}
      >
        프로그램 탭에서 보기
      </button>
    </div>
  )
}

/**
 * "이 항목 정리하기" (UI_SPEC.md §3.4): 정리 화면의 항목 목록에 있는 safe/caution 규칙일 때만 보인다.
 * 선택한 폴더 하나가 아니라 그 규칙 전체가 정리 단위다. 클릭하면 정리 화면의 확인 단계로 간다.
 */
function CleanButton({ match }: { match: RuleMatch }) {
  const item = useCleanupStore((s) => s.items?.find((i) => i.itemId === match.ruleId))
  const request = useCleanupStore((s) => s.requestItem)
  if (match.safety === 'protected' || match.safety === 'unknown' || !match.cleanable) return null
  if (!item || item.specialAction) {
    return (
      <p className="muted">정리 가능 항목이지만 이 버전에서는 정리 화면에서 지원하지 않습니다.</p>
    )
  }
  return (
    <button type="button" className="btn primary" onClick={() => request(item.itemId)}>
      이 항목 정리하기
    </button>
  )
}

function RuleInfo({ match }: { match: RuleMatch }) {
  if (match.safety === 'unknown') {
    return (
      <>
        <h3>이게 뭔가요?</h3>
        <p>알 수 없는 항목입니다. 탐색기에서 확인해 보세요.</p>
      </>
    )
  }
  return (
    <div className="rule-box">
      <h3>이게 뭔가요?</h3>
      <p>{match.description}</p>
      <h3>지우면?</h3>
      <p>{match.impact}</p>
      {match.safety === 'protected' && (
        <p>🔒 시스템/프로그램에 필요한 항목이라 삭제할 수 없습니다.</p>
      )}
      {match.safety !== 'protected' && !match.cleanable && (
        <p className="muted">
          이 앱에서는 삭제를 지원하지 않습니다. 필요하면 탐색기에서 직접 확인하세요.
        </p>
      )}
      <CleanButton match={match} />
      <p className="muted">
        {match.category ? `카테고리: ${CATEGORY_LABEL[match.category] ?? match.category} | ` : ''}
        규칙: {match.ruleId} ({match.source === 'user' ? '사용자 규칙' : '내장'})
      </p>
    </div>
  )
}

const CATEGORY_LABEL: Record<string, string> = {
  temp: '임시 파일',
  cache: '캐시',
  log: '로그',
  dump: '크래시 덤프',
  update: '업데이트',
  'dev-cache': '개발 캐시',
  'dev-build': '개발 산출물',
  'app-data': '앱 데이터',
  system: '시스템',
  'user-data': '사용자 데이터',
  program: '프로그램',
  game: '게임',
  vm: '가상 환경',
  other: '기타'
}
