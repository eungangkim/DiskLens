import type { TypeSummary } from '@shared/types'
import { formatBytes, formatNumber, formatPercent, TYPE_LABELS } from '../../lib/format'

/** 유형별 요약: 가로 막대 (UI_SPEC.md §3.6) */
export function TypesView({ types }: { types: TypeSummary[] | null }) {
  if (!types) return <p className="empty">불러오는 중…</p>
  const total = types.reduce((s, t) => s + t.bytes, 0)
  const max = Math.max(1, ...types.map((t) => t.bytes))
  return (
    <ul className="types" aria-label="유형별 용량">
      {types.map((t) => (
        <li key={t.type}>
          <span className="type-name">{TYPE_LABELS[t.type] ?? t.type}</span>
          <span className="type-bar" aria-hidden="true">
            <span style={{ width: `${(t.bytes / max) * 100}%` }} />
          </span>
          <span className="type-size">{formatBytes(t.bytes)}</span>
          <span className="type-pct muted">{formatPercent(total > 0 ? t.bytes / total : 0)}</span>
          <span className="type-count muted">{formatNumber(t.fileCount)}개</span>
        </li>
      ))}
    </ul>
  )
}
