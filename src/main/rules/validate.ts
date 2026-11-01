// 규칙 안전 검증 (DATA_SPEC.md §1.2 "검증 규칙" 8개). 순수 함수: 파일/OS에 접근하지 않는다.
// 위반한 규칙은 로드를 거부하고 사유를 돌려준다. 앱은 나머지 규칙으로 계속 동작한다.
import type { PathRule, RuleIssue, RuleSource } from '../../shared/rules.ts'
import type { ProtectedPaths } from '../safety/protectedPaths.ts'
import {
  expandEnv,
  hasGlobChars,
  isWithin,
  normalizeKey,
  sampleOfPattern,
  staticBase,
  type RuleEnv
} from './paths.ts'

export interface ValidationContext {
  env: RuleEnv
  protectedPaths: ProtectedPaths
}

/** 규칙이 가리키는 대상 경로 (환경변수 확장·정규화 후) */
export interface ResolvedPattern {
  /** 정규화(소문자) 패턴. name 규칙은 이름 하나 */
  key: string
  /** 환경변수만 확장한 원래 대소문자 패턴 (스캔 힌트용) */
  display: string
  /** 와일드카드 앞까지의 고정 경로. 고정 부분이 없으면 null */
  base: string | null
  /** 와일드카드를 대표 문자로 바꾼 표본 경로 (name 규칙은 null) */
  sample: string | null
}

export type ResolveResult = { ok: true; value: ResolvedPattern } | { ok: false; message: string }

export function resolvePattern(rule: PathRule, env: RuleEnv): ResolveResult {
  const { kind, pattern } = rule.match
  if (kind === 'name') {
    if (/[\\/*?%:]/.test(pattern)) {
      return {
        ok: false,
        message: 'name 규칙은 경로 구분자·와일드카드 없이 이름 하나만 쓸 수 있습니다.'
      }
    }
    return {
      ok: true,
      value: { key: pattern.toLowerCase(), display: pattern, base: null, sample: null }
    }
  }

  const expanded = expandEnv(pattern, env)
  if (!expanded.ok) {
    return { ok: false, message: `사용할 수 없는 환경변수입니다: %${expanded.variable}%` }
  }
  const key = normalizeKey(expanded.value)
  const absolute = /^[a-z]:\\/.test(key)
  const anywhere = kind === 'glob' && key.startsWith('**\\')
  if (!absolute && !anywhere) {
    return { ok: false, message: '드라이브 문자로 시작하는 절대 경로여야 합니다.' }
  }
  if (kind !== 'glob' && hasGlobChars(key)) {
    return {
      ok: false,
      message: 'exact/prefix 규칙에는 와일드카드(*, ?)를 쓸 수 없습니다. glob 을 사용하세요.'
    }
  }
  return {
    ok: true,
    value: {
      key,
      display: expanded.value.replace(/\//g, '\\'),
      base: staticBase(key),
      sample: sampleOfPattern(key)
    }
  }
}

/** "지나치게 넓은" 경로: 드라이브 루트, Users, 사용자 폴더 루트, AppData 루트류, 시스템 폴더 루트 */
export function broadRootKeys(env: RuleEnv): string[] {
  const names = [
    '%SYSTEMDRIVE%\\',
    '%SYSTEMDRIVE%\\Users',
    '%USERPROFILE%',
    '%LOCALAPPDATA%',
    '%APPDATA%'
  ]
  names.push('%WINDIR%', '%PROGRAMFILES%', '%PROGRAMFILES(X86)%', '%PROGRAMDATA%')
  names.push('%USERPROFILE%\\AppData', '%USERPROFILE%\\AppData\\LocalLow')
  const keys: string[] = []
  for (const n of names) {
    const r = expandEnv(n, env)
    if (r.ok) keys.push(normalizeKey(r.value))
  }
  return keys
}

function issue(
  rule: PathRule,
  source: RuleSource,
  code: RuleIssue['code'],
  message: string
): RuleIssue {
  return { ruleId: rule.id, source, code, message }
}

/**
 * 규칙 하나를 검증한다. 위반이 없으면 null.
 * 검사 순서: 패턴 해석 → 1 → 2 → 3 → 4 → 6(너무 넓음) → 5(보호 경로 침범) → 사용자 규칙 제한.
 * 6을 5보다 먼저 보는 이유: `%USERPROFILE%` 처럼 넓은 패턴은 "너무 넓다"가 더 알맞은 사유이기 때문이다.
 * 7(id 중복)과 8(protected 낮추기)은 규칙 여러 개를 함께 봐야 하므로 loader.ts 가 맡는다.
 */
export function validatePathRule(
  rule: PathRule,
  source: RuleSource,
  ctx: ValidationContext
): RuleIssue | null {
  const resolved = resolvePattern(rule, ctx.env)
  if (!resolved.ok) return issue(rule, source, 'invalid-pattern', resolved.message)
  const target = resolved.value
  const cleanup = rule.cleanup

  // 1. cleanable 인데 protected
  if (rule.cleanable && rule.safety === 'protected') {
    return issue(
      rule,
      source,
      'cleanable-protected',
      '보호(protected) 항목은 정리 대상이 될 수 없습니다.'
    )
  }
  // 2. cleanable 인데 cleanup 없음
  if (rule.cleanable && !cleanup) {
    return issue(
      rule,
      source,
      'cleanup-missing',
      '정리 가능(cleanable) 규칙에는 cleanup 설정이 필요합니다.'
    )
  }
  // 3. 영구 삭제 허용은 temp/cache 만
  if (cleanup?.allowPermanent && rule.category !== 'temp' && rule.category !== 'cache') {
    return issue(
      rule,
      source,
      'permanent-category',
      '영구 삭제(allowPermanent)는 temp/cache 카테고리에서만 허용됩니다. 로그·덤프는 휴지통 이동만 가능합니다.'
    )
  }
  // 4. 기본 선택은 safe 만
  if (cleanup?.defaultSelected && rule.safety !== 'safe') {
    return issue(
      rule,
      source,
      'default-selected-not-safe',
      '기본 선택(defaultSelected)은 safe 규칙에서만 가능합니다.'
    )
  }

  if (rule.cleanable) {
    // 6. 지나치게 넓은 패턴 (표시 전용 규칙은 정보 제공용이므로 예외)
    if (target.base === null) {
      return issue(
        rule,
        source,
        'too-broad',
        '위치를 특정할 수 없는 패턴(이름만, 또는 맨 앞이 와일드카드)은 정리 규칙으로 쓸 수 없습니다.'
      )
    }
    const broad = broadRootKeys(ctx.env)
    if (broad.some((b) => isWithin(b, target.base as string))) {
      return issue(
        rule,
        source,
        'too-broad',
        '드라이브 루트·Users·사용자 폴더 루트 등 지나치게 넓은 경로입니다.'
      )
    }

    // 5. 보호 경로 침범 (SAFETY.md §3) — §5 예외에 정확히 해당할 때만 허용
    const probes = [target.base, target.sample].filter((k): k is string => k !== null)
    for (const key of probes) {
      if (ctx.protectedPaths.status(key, cleanup?.specialAction) === 'protected') {
        return issue(
          rule,
          source,
          'protected-path',
          '보호 경로 안의 항목이며 SAFETY.md §5 의 정리 허용 예외에 해당하지 않습니다.'
        )
      }
    }
  }

  // 사용자 규칙은 관리자 권한 항목·전용 동작을 만들 수 없다 (ARCHITECTURE.md §7)
  if (source === 'user' && cleanup && (cleanup.requiresAdmin || cleanup.specialAction)) {
    return issue(
      rule,
      source,
      'user-privileged',
      '사용자 규칙은 관리자 권한이 필요한 정리나 전용 동작을 지정할 수 없습니다.'
    )
  }
  return null
}
