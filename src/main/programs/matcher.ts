// 프로그램 규칙 매처 (DATA_SPEC.md §1.3). 순수 함수, 읽기 전용.
import type { ProgramRule, RuleIssue } from '../../shared/rules.ts'
import type { RuleMatch } from '../../shared/types.ts'

export interface ProgramFacts {
  name: string
  publisher?: string | undefined
  isSystemComponent: boolean
}

interface Compiled {
  rule: ProgramRule
  regex: RegExp | null
  contains: string[]
  publisher: string[]
}

/** 보수적 순서 (SAFETY.md §2): 값이 클수록 보수적 */
const CONSERVATIVE = { safe: 0, caution: 1, protected: 2 } as const

const UNKNOWN: RuleMatch = { ruleId: null, safety: 'unknown', cleanable: false, canDelete: false }

/** 규칙이 없는 시스템 구성요소는 caution 으로 본다 (DATA_SPEC §1.3) */
const SYSTEM_COMPONENT: RuleMatch = {
  ruleId: null,
  safety: 'caution',
  name: '시스템 구성요소',
  category: 'system',
  description:
    'Windows나 다른 프로그램이 함께 설치한 구성요소입니다. 목록에서 숨겨지는 항목입니다.',
  impact: '다른 프로그램이 필요로 할 수 있습니다. 어떤 용도인지 모르면 그대로 두세요.',
  cleanable: false,
  canDelete: false
}

/** 규칙 하나를 검사한다. 조건이 하나도 없으면 모든 프로그램에 걸리므로 거부한다 */
export function validateProgramRule(rule: ProgramRule): RuleIssue | null {
  const m = rule.match
  const issue = (message: string): RuleIssue => ({
    ruleId: rule.id,
    source: 'builtin',
    code: 'invalid-pattern',
    message
  })
  if (!m.nameContains?.length && !m.nameRegex && !m.publisherContains?.length) {
    return issue('프로그램 규칙에 조건이 하나도 없습니다 (모든 프로그램에 걸리게 됩니다).')
  }
  if (m.nameRegex !== undefined) {
    try {
      new RegExp(m.nameRegex, 'i')
    } catch {
      return issue(`nameRegex 가 올바른 정규식이 아닙니다: ${m.nameRegex}`)
    }
  }
  return null
}

function compile(rule: ProgramRule): Compiled {
  return {
    rule,
    regex: rule.match.nameRegex !== undefined ? new RegExp(rule.match.nameRegex, 'i') : null,
    contains: (rule.match.nameContains ?? []).map((s) => s.toLowerCase()),
    publisher: (rule.match.publisherContains ?? []).map((s) => s.toLowerCase())
  }
}

function toMatch(rule: ProgramRule): RuleMatch {
  return {
    ruleId: rule.id,
    source: 'builtin',
    name: rule.name,
    safety: rule.safety,
    category: rule.category,
    description: rule.description,
    impact: rule.impact,
    cleanable: false,
    canDelete: false
  }
}

export class ProgramRuleMatcher {
  readonly #rules: Compiled[]

  /** 검증을 통과하지 못하는 규칙은 건너뛴다 (로더가 이미 거부하지만 이중으로 막는다) */
  constructor(rules: readonly ProgramRule[]) {
    this.#rules = rules.filter((r) => validateProgramRule(r) === null).map(compile)
  }

  /**
   * 조건은 모두 만족해야 한다(AND): nameContains 는 전부 포함, publisherContains 는 하나라도 포함.
   * 여러 규칙이 걸리면 보수적 안전도(protected > caution > safe)를 우선하고, 같으면 먼저 나온 규칙.
   */
  match(program: ProgramFacts): RuleMatch {
    const name = program.name.toLowerCase()
    const publisher = (program.publisher ?? '').toLowerCase()
    let best: Compiled | null = null
    for (const c of this.#rules) {
      if (c.contains.length > 0 && !c.contains.every((s) => name.includes(s))) continue
      if (c.regex && !c.regex.test(program.name)) continue
      if (c.publisher.length > 0 && !c.publisher.some((s) => publisher.includes(s))) continue
      if (!best || CONSERVATIVE[c.rule.safety] > CONSERVATIVE[best.rule.safety]) best = c
    }
    if (best) return toMatch(best.rule)
    return program.isSystemComponent ? SYSTEM_COMPONENT : UNKNOWN
  }
}
