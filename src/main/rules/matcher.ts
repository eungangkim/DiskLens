// 경로 → 규칙 매칭 (DATA_SPEC.md §1.2 "매칭 의미", SAFETY.md §2 판정 규칙). 순수 함수, 읽기 전용.
import type { PathRule, RuleSource } from '../../shared/rules.ts'
import type { RuleMatch } from '../../shared/types.ts'
import type { ProtectedPaths } from '../safety/protectedPaths.ts'
import { globToRegExp, normalizeKey } from './paths.ts'
import type { ResolvedPattern } from './validate.ts'

export interface LoadedRule {
  rule: PathRule
  source: RuleSource
  target: ResolvedPattern
}

export interface Lookup {
  match: RuleMatch
  /** 경로 자체가 규칙이 가리키는 대상인가 (false 면 상위 폴더 규칙을 물려받은 하위 경로) */
  root: boolean
}

export interface RuleLookup {
  lookup(path: string): Lookup
  /** 폴더 아래 합성 행(작은 폴더 모음, 직계 파일 모음)의 매칭: 하위로 상속되는 규칙만 적용된다 */
  lookupChild(parentPath: string): RuleMatch
}

const UNKNOWN: RuleMatch = { ruleId: null, safety: 'unknown', cleanable: false, canDelete: false }

/** 규칙이 없을 때 쓰는 매처 (단위 테스트·규칙 로드 실패 시) */
export const NO_RULES: RuleLookup = {
  lookup: () => ({ match: UNKNOWN, root: false }),
  lookupChild: () => UNKNOWN
}

/** SAFETY.md §2: 보수적 순서. 값이 클수록 보수적(더 안전하지 않음) */
const CONSERVATIVE: Record<string, number> = { safe: 0, caution: 1, unknown: 2, protected: 3 }

const KIND_RANK = { exact: 3, prefix: 2, glob: 2, name: 1 } as const

interface Candidate {
  loaded: LoadedRule
  root: boolean
  rank: number
  literal: number
}

interface GlobEntry {
  loaded: LoadedRule
  inherit: RegExp
  self: RegExp
  literal: number
}

/** 하드코딩 보호 구역 안인데 규칙이 없거나 규칙이 더 느슨할 때 쓰는 표시 (SAFETY.md §2 마지막 항목) */
export const HARDCODED_PROTECTED: RuleMatch = {
  ruleId: 'hardcoded-protected',
  source: 'builtin',
  name: '시스템/개인 폴더',
  safety: 'protected',
  category: 'system',
  description:
    'Windows 시스템 또는 개인 데이터가 들어 있는 폴더입니다. 이 앱은 이 폴더를 지우지 않습니다.',
  impact: '지우면 Windows나 프로그램이 정상 동작하지 않거나 개인 파일을 잃을 수 있습니다.',
  cleanable: false,
  canDelete: false
}

function toMatch(loaded: LoadedRule): RuleMatch {
  const { rule, source } = loaded
  return {
    ruleId: rule.id,
    source,
    name: rule.name,
    safety: rule.safety,
    category: rule.category,
    description: rule.description,
    impact: rule.impact,
    cleanable: rule.cleanable,
    // 실제 삭제 가능 여부는 safety 모듈(DeleteGuard)이 판정한다. 화면 연결은 7단계이며, 그 전까지 화면에서 삭제는 항상 불가.
    canDelete: false
  }
}

const literalLength = (key: string): number => key.replace(/[*?]/g, '').length

function better(a: Candidate, b: Candidate): Candidate {
  if (a.rank !== b.rank) return a.rank > b.rank ? a : b
  if (a.literal !== b.literal) return a.literal > b.literal ? a : b
  const ca = CONSERVATIVE[a.loaded.rule.safety] ?? 0
  const cb = CONSERVATIVE[b.loaded.rule.safety] ?? 0
  return cb > ca ? b : a
}

function pick(list: Candidate[]): Candidate | null {
  let best: Candidate | null = null
  for (const c of list) best = best ? better(best, c) : c
  return best
}

export class RuleMatcher implements RuleLookup {
  readonly #exact = new Map<string, LoadedRule[]>()
  readonly #prefix = new Map<string, LoadedRule[]>()
  readonly #names = new Map<string, LoadedRule[]>()
  readonly #globs: GlobEntry[] = []
  readonly #protectedPaths: ProtectedPaths
  readonly rules: readonly LoadedRule[]

  constructor(rules: readonly LoadedRule[], protectedPaths: ProtectedPaths) {
    this.rules = rules
    this.#protectedPaths = protectedPaths
    const add = (map: Map<string, LoadedRule[]>, key: string, r: LoadedRule): void => {
      const list = map.get(key)
      if (list) list.push(r)
      else map.set(key, [r])
    }
    for (const loaded of rules) {
      const { kind } = loaded.rule.match
      const { key } = loaded.target
      if (kind === 'exact') add(this.#exact, key, loaded)
      else if (kind === 'prefix') add(this.#prefix, key, loaded)
      else if (kind === 'name') add(this.#names, key, loaded)
      else {
        this.#globs.push({
          loaded,
          inherit: globToRegExp(key, true),
          self: globToRegExp(key, false),
          literal: literalLength(key)
        })
      }
    }
  }

  #candidates(key: string, includeUser: boolean): Candidate[] {
    const out: Candidate[] = []
    const accept = (l: LoadedRule): boolean => includeUser || l.source === 'builtin'

    for (const loaded of this.#exact.get(key) ?? []) {
      if (accept(loaded))
        out.push({ loaded, root: true, rank: KIND_RANK.exact, literal: key.length })
    }

    // prefix: 경로 자신과 모든 상위 폴더를 차례로 조회
    let current = key
    for (;;) {
      for (const loaded of this.#prefix.get(current) ?? []) {
        if (accept(loaded)) {
          out.push({
            loaded,
            root: current === key,
            rank: KIND_RANK.prefix,
            literal: current.length
          })
        }
      }
      if (current.length <= 3) break // 드라이브 루트(`c:\`)까지 봤으면 끝
      const cut = current.lastIndexOf('\\')
      // `c:\foo` 의 상위는 `c:\` (구분자를 남긴다)
      current = cut <= 2 ? current.slice(0, 3) : current.slice(0, cut)
    }

    for (const g of this.#globs) {
      if (!accept(g.loaded) || !g.inherit.test(key)) continue
      out.push({
        loaded: g.loaded,
        root: g.self.test(key),
        rank: KIND_RANK.glob,
        literal: g.literal
      })
    }

    if (this.#names.size > 0) {
      const segments = key.split('\\')
      for (let i = 1; i < segments.length; i++) {
        for (const loaded of this.#names.get(segments[i] as string) ?? []) {
          if (accept(loaded)) {
            out.push({ loaded, root: i === segments.length - 1, rank: KIND_RANK.name, literal: 0 })
          }
        }
      }
    }
    return out
  }

  lookup(path: string): Lookup {
    const key = normalizeKey(path)
    // 사용자 규칙은 내장 규칙이 protected 로 판정한 곳의 안전도를 낮출 수 없다 (DATA_SPEC §1.2-8)
    const builtinBest = pick(this.#candidates(key, false))
    let best: Candidate | null
    if (builtinBest?.loaded.rule.safety === 'protected') best = builtinBest
    else best = pick(this.#candidates(key, true))

    if (best?.loaded.rule.safety === 'protected')
      return { match: toMatch(best.loaded), root: best.root }
    // 하드코딩 보호 구역(SAFETY.md §3)은 규칙이 느슨해도 🔴 로 표시한다. 정리 허용 예외는 구역 밖으로 본다.
    if (this.#protectedPaths.isProtectedForDisplay(path)) {
      return { match: HARDCODED_PROTECTED, root: false }
    }
    if (!best) return { match: UNKNOWN, root: false }
    return { match: toMatch(best.loaded), root: best.root }
  }

  lookupChild(parentPath: string): RuleMatch {
    const key = normalizeKey(parentPath)
    const child = key.endsWith('\\') ? `${key}\u0001` : `${key}\\\u0001`
    return this.lookup(child).match
  }

  /**
   * 이 폴더의 하위 전체에 적용되는 규칙 (폴더 안의 폴더 안까지). 자기 자신에만 적용되는 규칙(exact)과,
   * 직계 하위 한 단계에만 걸리는 보호 구역(예: C:\Users 아래 각 사용자 폴더)은 제외된다. 용량 집계 보고서용.
   */
  lookupSubtree(path: string): RuleMatch {
    const key = normalizeKey(path)
    const sep = key.endsWith('\\') ? '' : '\\'
    return this.lookup(`${key}${sep}\u0001\\\u0001`).match
  }

  /** 스캔 시 접지 않을 경로/이름 (ARCHITECTURE.md §5): 규칙이 가리키는 폴더가 "기타"로 사라지지 않게 한다 */
  scanHints(): { keepPaths: string[]; keepNames: string[] } {
    const keepPaths = new Set<string>()
    const keepNames = new Set<string>()
    for (const { rule, target } of this.rules) {
      if (rule.match.kind === 'name') keepNames.add(target.display)
      else if (rule.match.kind === 'exact' || rule.match.kind === 'prefix')
        keepPaths.add(target.display)
    }
    return { keepPaths: [...keepPaths], keepNames: [...keepNames] }
  }
}
