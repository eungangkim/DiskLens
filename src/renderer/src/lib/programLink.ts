import type { InstalledProgram } from '@shared/types'

const key = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 폴더 경로가 어느 프로그램의 설치 폴더(또는 그 하위)인가. 여러 개면 가장 깊은(구체적인) 설치 폴더를 고른다 */
export function findProgramForPath(
  programs: readonly InstalledProgram[],
  path: string
): InstalledProgram | null {
  const target = key(path)
  let best: InstalledProgram | null = null
  let bestLen = -1
  for (const p of programs) {
    if (!p.installLocation) continue
    const loc = key(p.installLocation)
    const inside = target === loc || target.startsWith(loc + '\\')
    if (inside && loc.length > bestLen) {
      best = p
      bestLen = loc.length
    }
  }
  return best
}
