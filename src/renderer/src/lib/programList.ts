import type { InstalledProgram } from '@shared/types'

export type ProgramSort = 'size' | 'name' | 'date'

/** 화면에 보여 줄 목록: 시스템 구성요소 필터 → 검색 → 정렬 */
export function visiblePrograms(
  programs: readonly InstalledProgram[],
  opts: { includeSystem: boolean; query: string; sort: ProgramSort }
): InstalledProgram[] {
  const q = opts.query.trim().toLowerCase()
  const list = programs.filter(
    (p) =>
      (opts.includeSystem || !p.isSystemComponent) &&
      (q === '' ||
        p.name.toLowerCase().includes(q) ||
        (p.publisher ?? '').toLowerCase().includes(q))
  )
  const size = (p: InstalledProgram): number => p.estimatedSizeBytes ?? -1
  if (opts.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  else if (opts.sort === 'date')
    list.sort(
      (a, b) => (b.installDate ?? '').localeCompare(a.installDate ?? '') || size(b) - size(a)
    )
  else list.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name, 'ko'))
  return list
}
