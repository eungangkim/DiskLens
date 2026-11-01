// 정리 대상 해석 (규칙 cleanup 설정 → 실제 파일 목록). 읽기 전용: 아무것도 지우지 않는다.
// - 규칙 루트: exact/prefix 는 패턴 경로 하나, glob 은 와일드카드를 실제 폴더로 펼친다 (링크는 따라가지 않음).
// - 대상: 루트 아래 파일 전체(링크는 건너뜀). includeGlobs/excludeGlobs/minAgeDays 를 파일 단위로 적용한다.
// - 비게 된 폴더는 아래에서 위 순서(post-order)로 알려 준다 (contents 모드는 루트 폴더를 제외한다).
import type { CleanupSpec } from '../../shared/rules.ts'
import type { LoadedRule } from '../rules/matcher.ts'
import { globToRegExp, hasGlobChars } from '../rules/paths.ts'
import type { FsReader } from '../safety/fsReader.ts'

const DAY_MS = 86_400_000
const MAX_ROOTS = 500
const MAX_WILDCARD_DEPTH = 6

export type TargetEvent =
  | { type: 'file'; path: string; size: number }
  | { type: 'dir'; path: string }
  | { type: 'link'; path: string }
  | { type: 'error'; path: string; code: string }

async function directoriesIn(fs: FsReader, dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const full = joinPath(dir, name)
    try {
      const stat = await fs.lstat(full)
      if (stat.isDirectory && !stat.isSymbolicLink) out.push(full)
    } catch {
      // 사라졌거나 읽을 수 없는 항목은 규칙 루트 후보에서 뺀다
    }
  }
  return out
}

const joinPath = (dir: string, name: string): string => `${dir.replace(/\\+$/, '')}\\${name}`

/** 규칙이 가리키는 폴더들. 존재 여부는 확인하지 않는다 (exact/prefix) / 존재하는 것만 (glob) */
export async function resolveRoots(rule: LoadedRule, fs: FsReader): Promise<string[]> {
  const { display } = rule.target
  if (rule.rule.match.kind !== 'glob' || !hasGlobChars(display)) return [display]

  const segments = display.split('\\')
  const firstWild = segments.findIndex((s) => hasGlobChars(s))
  if (firstWild < 1) return [] // 맨 앞이 와일드카드인 패턴은 정리 규칙이 될 수 없다 (로더가 거부한다)
  const base = segments.slice(0, firstWild).join('\\')
  const roots: string[] = []

  const walk = async (dir: string, index: number, depth: number): Promise<void> => {
    if (roots.length >= MAX_ROOTS) return
    if (index >= segments.length) {
      roots.push(dir)
      return
    }
    const seg = segments[index] as string
    if (seg === '**') {
      await walk(dir, index + 1, depth)
      if (depth < MAX_WILDCARD_DEPTH) {
        for (const child of await directoriesIn(fs, dir)) await walk(child, index, depth + 1)
      }
    } else if (hasGlobChars(seg)) {
      const re = globToRegExp(seg.toLowerCase(), false)
      for (const child of await directoriesIn(fs, dir)) {
        if (re.test(child.slice(child.lastIndexOf('\\') + 1).toLowerCase())) {
          await walk(child, index + 1, depth)
        }
      }
    } else {
      await walk(joinPath(dir, seg), index + 1, depth)
    }
  }
  await walk(base.length === 2 ? `${base}\\` : base, firstWild, 0)
  return roots
}

interface Filters {
  include: RegExp[]
  exclude: RegExp[]
  includeRel: boolean[]
  excludeRel: boolean[]
  minAgeMs: number | null
}

function compileGlobs(patterns: readonly string[] | undefined): { res: RegExp[]; rel: boolean[] } {
  const res: RegExp[] = []
  const rel: boolean[] = []
  for (const p of patterns ?? []) {
    const normalized = p.replace(/\//g, '\\').toLowerCase()
    res.push(globToRegExp(normalized, false))
    rel.push(normalized.includes('\\'))
  }
  return { res, rel }
}

function compileFilters(spec: CleanupSpec): Filters {
  const inc = compileGlobs(spec.includeGlobs)
  const exc = compileGlobs(spec.excludeGlobs)
  return {
    include: inc.res,
    includeRel: inc.rel,
    exclude: exc.res,
    excludeRel: exc.rel,
    minAgeMs: spec.minAgeDays ? spec.minAgeDays * DAY_MS : null
  }
}

function anyMatch(res: RegExp[], rel: boolean[], relPath: string, name: string): boolean {
  return res.some((re, i) => re.test(rel[i] ? relPath : name))
}

/**
 * 규칙 루트 하나의 대상을 훑는다. 순서는 파일 → (비게 된) 폴더 순이며, 폴더는 자식 뒤에 나온다.
 * contents 모드는 루트 폴더 자체를 알리지 않고, self 모드는 마지막에 루트를 알린다.
 */
export async function* enumerateTargets(
  rule: LoadedRule,
  root: string,
  fs: FsReader,
  now: number
): AsyncGenerator<TargetEvent> {
  const spec = rule.rule.cleanup
  if (!spec) return
  const filters = compileFilters(spec)

  let rootStat
  try {
    rootStat = await fs.lstat(root)
  } catch {
    return // 루트가 없으면 정리할 것이 없다
  }
  if (rootStat.isSymbolicLink) {
    yield { type: 'link', path: root }
    return
  }
  if (!rootStat.isDirectory) return

  async function* visit(dir: string, rel: string): AsyncGenerator<TargetEvent> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      yield { type: 'error', path: dir, code: errorCodeOf(error) }
      return
    }
    for (const name of names) {
      const full = joinPath(dir, name)
      const relPath = rel ? `${rel}\\${name}` : name
      let stat
      try {
        stat = await fs.lstat(full)
      } catch (error) {
        yield { type: 'error', path: full, code: errorCodeOf(error) }
        continue
      }
      if (stat.isSymbolicLink) {
        yield { type: 'link', path: full }
        continue
      }
      if (stat.isDirectory) {
        yield* visit(full, relPath)
        yield { type: 'dir', path: full }
        continue
      }
      if (!stat.isFile) continue
      const lowerRel = relPath.toLowerCase()
      const lowerName = name.toLowerCase()
      if (
        filters.include.length > 0 &&
        !anyMatch(filters.include, filters.includeRel, lowerRel, lowerName)
      )
        continue
      if (anyMatch(filters.exclude, filters.excludeRel, lowerRel, lowerName)) continue
      if (filters.minAgeMs !== null && now - stat.mtimeMs < filters.minAgeMs) continue
      yield { type: 'file', path: full, size: stat.size }
    }
  }

  yield* visit(root, '')
  if (spec.mode === 'self') yield { type: 'dir', path: root }
}

function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'UNKNOWN'
}
