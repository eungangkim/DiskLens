import { useEffect, useState } from 'react'
import type { SafetyFilter } from '@shared/ipc'
import { useScanStore } from '../../store/scanStore'

const OPTIONS: Array<{ id: SafetyFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'safe', label: '✔ 안전' },
  { id: 'caution', label: '⚠ 주의' },
  { id: 'protected', label: '🔒 보호' },
  { id: 'unknown', label: '? 알 수 없음' }
]

/** 안전도 필터 / "지워도 되는 것만 큰 순으로" / 이름 검색 (UI_SPEC.md §3.3). 조건이 있으면 큰 순 평면 목록으로 바뀐다 */
export function FilterBar() {
  const filter = useScanStore((s) => s.filter)
  const setFilter = useScanStore((s) => s.setFilter)
  const [text, setText] = useState(filter.query)

  // 검색어는 입력이 멈춘 뒤에 적용한다
  useEffect(() => {
    if (text === filter.query) return
    const t = setTimeout(() => void setFilter({ query: text }), 250)
    return () => clearTimeout(t)
  }, [text, filter.query, setFilter])

  return (
    <div className="filter-bar" role="group" aria-label="필터">
      <div className="seg" role="radiogroup" aria-label="안전도 필터">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={filter.safety === o.id}
            className={filter.safety === o.id ? 'seg-btn active' : 'seg-btn'}
            onClick={() => void setFilter({ safety: o.id })}
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={filter.cleanableOnly}
          onChange={(e) => void setFilter({ cleanableOnly: e.target.checked })}
        />
        지워도 되는 것만 큰 순으로
      </label>
      <input
        type="search"
        className="search"
        placeholder="이름 검색"
        aria-label="이름 검색"
        maxLength={100}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  )
}
