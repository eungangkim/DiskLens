// 규칙 DB 로더: JSON → zod 구조 검사 → 안전 검증(validate.ts) → 중복/사용자 규칙 검사 → 매처 생성.
// 잘못된 규칙은 그 규칙만 거부하고(경고 목록에 담는다) 나머지로 계속 동작한다.
import { readFile } from 'node:fs/promises'
import {
  pathRuleSchema,
  programRuleSchema,
  rulesFileSchema,
  type PathRule,
  type ProgramRule,
  type RuleIssue,
  type RuleSource
} from '../../shared/rules.ts'
import { validateProgramRule } from '../programs/matcher.ts'
import { createProtectedPaths, type ProtectedContext } from '../safety/protectedPaths.ts'
import { RuleMatcher, type LoadedRule } from './matcher.ts'
import { resolvePattern, validatePathRule, type ValidationContext } from './validate.ts'

export interface LoadedRuleSet {
  matcher: RuleMatcher
  rulesVersion: string
  programRules: ProgramRule[]
  /** 로드가 거부된 규칙과 사유 (앱은 경고 로그로 남긴다) */
  issues: RuleIssue[]
  counts: { builtin: number; user: number }
}

interface ParsedFile {
  rulesVersion: string
  pathRules: unknown[]
  programRules: unknown[]
}

function parseFile(raw: unknown, source: RuleSource, issues: RuleIssue[]): ParsedFile | null {
  const parsed = rulesFileSchema.safeParse(raw)
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || '(root)'
    issues.push({
      ruleId: '(file)',
      source,
      code: 'schema',
      message: `규칙 파일 구조가 올바르지 않습니다: ${where}`
    })
    return null
  }
  return parsed.data
}

/**
 * 내장 규칙(필수)과 사용자 규칙(선택)을 합쳐 매처를 만든다. 파일 접근 없음.
 * - 7: 같은 id 는 먼저 나온 것을 유지하고 뒤의 것을 거부 (내장이 사용자보다 먼저)
 * - 8: 사용자 규칙은 내장/하드코딩이 protected 로 판정한 경로의 안전도를 낮출 수 없다
 */
export function buildRuleSet(
  input: { builtin: unknown; user?: unknown },
  context: ProtectedContext
): LoadedRuleSet {
  const issues: RuleIssue[] = []
  const protectedPaths = createProtectedPaths(context)
  const vctx: ValidationContext = { env: context.env, protectedPaths }

  const builtinFile = parseFile(input.builtin, 'builtin', issues)
  const userFile = input.user === undefined ? null : parseFile(input.user, 'user', issues)

  const seen = new Set<string>()
  const accepted: LoadedRule[] = []
  let builtinMatcher = new RuleMatcher([], protectedPaths)

  const consider = (rawRule: unknown, source: RuleSource): void => {
    const idHint =
      typeof rawRule === 'object' && rawRule !== null && 'id' in rawRule
        ? String((rawRule as { id: unknown }).id)
        : '(id 없음)'
    const parsed = pathRuleSchema.safeParse(rawRule)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      issues.push({
        ruleId: idHint,
        source,
        code: 'schema',
        message: `규칙 형식 오류: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim()
      })
      return
    }
    const rule: PathRule = parsed.data

    // 7. id 중복
    if (seen.has(rule.id)) {
      issues.push({
        ruleId: rule.id,
        source,
        code: 'duplicate-id',
        message: '이미 같은 id 의 규칙이 있어 이 규칙은 무시합니다.'
      })
      return
    }

    const problem = validatePathRule(rule, source, vctx)
    if (problem) {
      issues.push(problem)
      return
    }

    const resolved = resolvePattern(rule, context.env)
    if (!resolved.ok) return // validatePathRule 이 이미 거른다 (타입 좁히기용)

    // 8. 사용자 규칙이 protected 를 낮추려는 경우
    if (source === 'user' && rule.safety !== 'protected' && resolved.value.sample !== null) {
      const existing = builtinMatcher.lookup(resolved.value.sample).match
      if (existing.safety === 'protected') {
        issues.push({
          ruleId: rule.id,
          source,
          code: 'protected-downgrade',
          message: `보호(protected) 항목(${existing.name ?? existing.ruleId ?? ''})의 안전도를 낮출 수 없습니다.`
        })
        return
      }
    }

    seen.add(rule.id)
    accepted.push({ rule, source, target: resolved.value })
  }

  for (const r of builtinFile?.pathRules ?? []) consider(r, 'builtin')
  const builtinCount = accepted.length
  builtinMatcher = new RuleMatcher([...accepted], protectedPaths)
  for (const r of userFile?.pathRules ?? []) consider(r, 'user')

  const programRules: ProgramRule[] = []
  for (const r of builtinFile?.programRules ?? []) {
    const parsed = programRuleSchema.safeParse(r)
    if (parsed.success) {
      const problem = validateProgramRule(parsed.data)
      if (problem) issues.push(problem)
      else if (programRules.some((p) => p.id === parsed.data.id)) {
        issues.push({
          ruleId: parsed.data.id,
          source: 'builtin',
          code: 'duplicate-id',
          message: '이미 같은 id 의 프로그램 규칙이 있어 이 규칙은 무시합니다.'
        })
      } else programRules.push(parsed.data)
    } else {
      issues.push({
        ruleId:
          typeof r === 'object' && r !== null && 'id' in r
            ? String((r as { id: unknown }).id)
            : '(id 없음)',
        source: 'builtin',
        code: 'schema',
        message: '프로그램 규칙 형식 오류'
      })
    }
  }

  return {
    matcher: new RuleMatcher(accepted, protectedPaths),
    rulesVersion: builtinFile?.rulesVersion ?? 'unknown',
    programRules,
    issues,
    counts: { builtin: builtinCount, user: accepted.length - builtinCount }
  }
}

async function readJson(
  path: string
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) as unknown }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 파일에서 규칙을 읽는다. 사용자 규칙 파일이 없으면 조용히 건너뛰고(선택 기능),
 * 읽을 수 없거나 JSON 이 깨졌으면 경고로 남기고 계속한다. 내장 규칙을 못 읽으면 규칙 없이 동작한다(모두 unknown).
 */
export async function loadRuleSetFromFiles(
  paths: { builtin: string; user?: string },
  context: ProtectedContext
): Promise<LoadedRuleSet> {
  const extra: RuleIssue[] = []
  const builtin = await readJson(paths.builtin)
  if (!builtin.ok) {
    extra.push({
      ruleId: '(file)',
      source: 'builtin',
      code: 'schema',
      message: `내장 규칙을 읽지 못했습니다: ${builtin.error}`
    })
  }
  let user: unknown
  if (paths.user) {
    const read = await readJson(paths.user)
    if (read.ok) user = read.value
    else if (!/ENOENT/.test(read.error)) {
      extra.push({
        ruleId: '(file)',
        source: 'user',
        code: 'schema',
        message: `사용자 규칙을 읽지 못했습니다: ${read.error}`
      })
    }
  }
  const set = buildRuleSet(
    { builtin: builtin.ok ? builtin.value : undefined, ...(user !== undefined ? { user } : {}) },
    context
  )
  // 내장 파일을 못 읽은 경우 buildRuleSet 이 만든 구조 오류와 중복되지 않게 읽기 오류를 앞에 둔다
  set.issues.unshift(...extra)
  return set
}
