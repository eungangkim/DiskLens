import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { NodeView } from '@shared/types'
import { useScanStore } from '../../store/scanStore'
import { SafetyBadge } from '../../components/SafetyBadge'
import { formatBytes, formatNumber, formatPercent } from '../../lib/format'

interface Row {
  view: NodeView
  depth: number
  parentId: string | null
}

const ROW_HEIGHT = 32

/** 폴더 트리: 가상 스크롤 + 지연 로딩 (펼칠 때 scan:getChildren) */
export function FolderTree() {
  const rootView = useScanStore((s) => s.rootView)
  const children = useScanStore((s) => s.children)
  const expanded = useScanStore((s) => s.expanded)
  const loading = useScanStore((s) => s.loading)
  const selected = useScanStore((s) => s.selected)
  const { toggle, expand, collapse, select } = useScanStore.getState()
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows = useMemo<Row[]>(() => {
    if (!rootView) return []
    const out: Row[] = []
    const walk = (view: NodeView, depth: number, parentId: string | null): void => {
      out.push({ view, depth, parentId })
      if (view.kind === 'folder' && expanded[view.id]) {
        for (const child of children[view.id] ?? []) walk(child, depth + 1, view.id)
      }
    }
    walk(rootView, 0, null)
    return out
  }, [rootView, children, expanded])

  // TanStack Virtual은 React Compiler 메모이제이션과 호환되지 않아 경고가 나지만, 이 컴포넌트에서는 문제 없다
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const selectedIndex = rows.findIndex((r) => r.view.id === selected?.id)

  // 다른 화면(프로그램 탭)에서 이 폴더를 보러 왔을 때만 선택 행으로 스크롤한다
  const revealSeq = useScanStore((s) => s.revealSeq)
  useEffect(() => {
    if (revealSeq > 0 && selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: 'center' })
    }
    // revealSeq 가 바뀔 때만 실행한다 (사용자가 직접 펼치고 접을 때는 스크롤하지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq])

  const moveTo = (index: number): void => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    select(row.view)
    virtualizer.scrollToIndex(rows.indexOf(row), { align: 'auto' })
  }

  // UI_SPEC.md §3.3: ↑↓ 이동, →← 펼치기/접기, Enter 상세. Delete 키는 아무 동작도 하지 않는다.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[selectedIndex]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveTo(selectedIndex < 0 ? 0 : selectedIndex + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveTo(selectedIndex < 0 ? 0 : selectedIndex - 1)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (row?.view.kind === 'folder' && row.view.hasChildren) {
          if (!expanded[row.view.id]) void expand(row.view.id)
          else moveTo(selectedIndex + 1)
        }
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (row && expanded[row.view.id]) collapse(row.view.id)
        else if (row?.parentId) {
          const p = rows.findIndex((r) => r.view.id === row.parentId)
          if (p >= 0) moveTo(p)
        }
        break
      case 'Enter':
        e.preventDefault()
        if (row) select(row.view)
        break
      default:
        break
    }
  }

  return (
    <div className="tree">
      <div className="tree-head" role="row">
        <span className="c-name">이름</span>
        <span className="c-size">크기</span>
        <span className="c-pct">비율</span>
        <span className="c-files">파일 수</span>
        <span className="c-safety">안전도</span>
        <span className="c-desc">설명</span>
      </div>
      <div
        className="tree-body"
        ref={scrollRef}
        role="tree"
        aria-label="폴더 트리"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-activedescendant={selected ? `row-${selected.id}` : undefined}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            if (!row) return null
            const { view, depth } = row
            const isFolder = view.kind === 'folder'
            const isOpen = !!expanded[view.id]
            return (
              <div
                key={view.id}
                id={`row-${view.id}`}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={isFolder && view.hasChildren ? isOpen : undefined}
                aria-selected={selected?.id === view.id}
                className={selected?.id === view.id ? 'tree-row selected' : 'tree-row'}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${v.start}px)`,
                  height: ROW_HEIGHT
                }}
                onClick={() => select(view)}
                onDoubleClick={() => isFolder && view.hasChildren && void toggle(view.id)}
              >
                <span className="c-name" style={{ paddingLeft: Math.min(depth, 14) * 14 }}>
                  {isFolder && view.hasChildren ? (
                    <button
                      type="button"
                      className="twisty"
                      tabIndex={-1}
                      aria-label={isOpen ? '접기' : '펼치기'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggle(view.id)
                      }}
                    >
                      {loading[view.id] ? '…' : isOpen ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className="twisty-space" />
                  )}
                  <span aria-hidden="true">
                    {view.isLink ? '🔗' : view.kind === 'folder' ? '📁' : '📄'}
                  </span>{' '}
                  <span className="ellipsis" title={view.path}>
                    {view.name}
                    {view.isLink && <span className="muted"> (링크, 집계 제외)</span>}
                    {view.cloudOnly && <span aria-label="클라우드 전용"> ☁</span>}
                  </span>
                </span>
                <span className="c-size">{formatBytes(view.size)}</span>
                <span className="c-pct">
                  <span className="pctbar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, view.percentOfParent * 100)}%` }} />
                  </span>
                  {formatPercent(view.percentOfParent)}
                </span>
                <span className="c-files">
                  {view.fileCount !== undefined ? formatNumber(view.fileCount) : '—'}
                </span>
                <span className="c-safety">
                  <SafetyBadge safety={view.match.safety} />
                </span>
                <span className="c-desc muted" title={view.match.description ?? undefined}>
                  {view.match.name ?? '—'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
