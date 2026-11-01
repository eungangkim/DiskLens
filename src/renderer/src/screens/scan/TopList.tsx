import type { NodeView } from '@shared/types'
import { useScanStore } from '../../store/scanStore'
import { SafetyBadge } from '../../components/SafetyBadge'
import { formatBytes, formatDateTime, formatNumber, formatPercent } from '../../lib/format'

/** 큰 파일 Top / 큰 폴더 Top 공용 목록. 삭제 버튼은 없다: 선택 후 상세 패널의 "탐색기에서 열기"만 제공 */
export function TopList({ kind, items }: { kind: 'files' | 'folders'; items: NodeView[] | null }) {
  const selected = useScanStore((s) => s.selected)
  const select = useScanStore((s) => s.select)

  if (!items) return <p className="empty">불러오는 중…</p>
  if (items.length === 0) return <p className="empty">표시할 항목이 없습니다.</p>

  return (
    <div className="toplist">
      <table>
        <colgroup>
          <col style={{ width: 40 }} />
          <col style={{ width: 150 }} />
          <col />
          <col style={{ width: 80 }} />
          <col style={{ width: 80 }} />
          {kind === 'files' ? (
            <>
              <col style={{ width: 130 }} />
              <col style={{ width: 70 }} />
            </>
          ) : (
            <col style={{ width: 80 }} />
          )}
          <col style={{ width: 110 }} />
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>{kind === 'files' ? '파일명' : '폴더명'}</th>
            <th>경로</th>
            <th className="num">크기</th>
            <th className="num">전체 대비</th>
            {kind === 'files' ? (
              <>
                <th>수정일</th>
                <th>확장자</th>
              </>
            ) : (
              <th className="num">파일 수</th>
            )}
            <th>안전도</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v, i) => (
            <tr
              key={v.id}
              className={selected?.id === v.id ? 'selected' : undefined}
              onClick={() => select(v)}
            >
              <td className="muted">{i + 1}</td>
              <td>
                <span aria-hidden="true">{kind === 'files' ? '📄' : '📁'}</span> {v.name}
              </td>
              <td className="path" title={v.path}>
                <span className="ellipsis-start">{v.path}</span>
              </td>
              <td className="num">{formatBytes(v.size)}</td>
              <td className="num">{formatPercent(v.percentOfTotal)}</td>
              {kind === 'files' ? (
                <>
                  <td>{v.modifiedAt ? formatDateTime(v.modifiedAt) : '—'}</td>
                  <td>{v.ext || '—'}</td>
                </>
              ) : (
                <td className="num">{formatNumber(v.fileCount ?? 0)}</td>
              )}
              <td>
                <SafetyBadge safety={v.match.safety} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
