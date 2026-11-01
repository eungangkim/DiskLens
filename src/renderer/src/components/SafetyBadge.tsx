import type { RuleMatch } from '@shared/types'

// UI_SPEC.md §2.1: 색 + 아이콘 + 텍스트를 항상 함께 쓴다 (색만으로 구분하지 않음).
const BADGES: Record<RuleMatch['safety'], { icon: string; label: string; tip: string }> = {
  safe: { icon: '✔', label: '안전', tip: '지워도 시스템/프로그램에 문제가 없습니다' },
  caution: { icon: '⚠', label: '주의', tip: '지울 수 있지만 영향이 있습니다' },
  protected: { icon: '🔒', label: '보호', tip: '시스템/프로그램에 필요한 항목입니다' },
  unknown: { icon: '?', label: '알 수 없음', tip: '아직 설명 규칙이 없는 항목입니다' }
}

export function SafetyBadge({ safety }: { safety: RuleMatch['safety'] }) {
  const b = BADGES[safety]
  return (
    <span className={`badge badge-${safety}`} title={b.tip}>
      <span aria-hidden="true">{b.icon}</span> {b.label}
    </span>
  )
}
