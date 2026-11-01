// 규칙 DB용 경로 유틸 (순수 함수). Windows 경로는 대소문자를 무시하므로 비교 키는 모두 소문자로 만든다.

/** 규칙 패턴에서 허용되는 환경변수 (DATA_SPEC.md §1.2) */
export const ALLOWED_ENV_VARS = [
  'LOCALAPPDATA',
  'USERPROFILE',
  'APPDATA',
  'PROGRAMDATA',
  'WINDIR',
  'SYSTEMDRIVE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)'
] as const

export type RuleEnv = Readonly<Record<string, string | undefined>>

/**
 * 비교용 키: 슬래시 통일, `\\?\` 접두사 제거, 중복 구분자 제거, 끝의 `\` 제거(드라이브 루트 제외), 소문자.
 * 드라이브 루트는 `c:\` 형태로 유지한다.
 */
export function normalizeKey(path: string): string {
  let p = path.replace(/\//g, '\\')
  if (p.startsWith('\\\\?\\')) p = p.slice(4)
  p = p.replace(/(?!^)\\{2,}/g, '\\')
  p = p.toLowerCase()
  if (/^[a-z]:$/.test(p)) return `${p}\\`
  if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1)
  return p
}

/** child 가 parent 와 같거나 그 하위인가 (경계 `\` 확인: c:\temp2 는 c:\temp 의 하위가 아니다) */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const prefix = parent.endsWith('\\') ? parent : `${parent}\\`
  return child.startsWith(prefix)
}

export function lookupEnv(env: RuleEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value) return value
  }
  return undefined
}

export type ExpandResult = { ok: true; value: string } | { ok: false; variable: string }

/** `%NAME%` 을 실제 값으로 바꾼다. 허용 목록 밖이거나 값이 없는 변수는 실패로 돌려준다 */
export function expandEnv(pattern: string, env: RuleEnv): ExpandResult {
  let failed: string | null = null
  const value = pattern.replace(/%([^%]+)%/g, (whole, name: string) => {
    const allowed = ALLOWED_ENV_VARS.some((v) => v === name.toUpperCase())
    const resolved = allowed ? lookupEnv(env, name) : undefined
    if (resolved === undefined) {
      failed ??= name
      return whole
    }
    return resolved.replace(/[\\/]+$/, '')
  })
  return failed === null ? { ok: true, value } : { ok: false, variable: failed }
}

const hasWildcard = (s: string): boolean => /[*?]/.test(s)

/**
 * 패턴에서 와일드카드가 나오기 전까지의 고정 경로. 맨 앞부터 와일드카드면 null.
 * (예: `c:\users\me\appdata\*\cache` → `c:\users\me\appdata`)
 */
export function staticBase(normalizedPattern: string): string | null {
  const segments = normalizedPattern.split('\\')
  const fixed: string[] = []
  for (const seg of segments) {
    if (hasWildcard(seg)) break
    fixed.push(seg)
  }
  if (fixed.length === 0 || fixed[0] === '') return null
  if (fixed.length === 1 && /^[a-z]:$/.test(fixed[0] as string)) return `${fixed[0]}\\`
  return fixed.join('\\')
}

export const hasGlobChars = hasWildcard

/**
 * 정규화된(소문자) glob 패턴 → 정규식.
 * `*` 한 구간 안의 임의 글자, `?` 한 글자, `**` 0개 이상의 구간. descendants 면 일치한 경로의 하위도 일치한다.
 */
export function globToRegExp(normalizedPattern: string, descendants: boolean): RegExp {
  let out = ''
  const p = normalizedPattern
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '\\') {
          out += '(?:.*\\\\)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^\\\\]*'
      }
    } else if (c === '?') {
      out += '[^\\\\]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}${descendants ? '(?:\\\\.*)?' : ''}$`)
}

/** 와일드카드를 대표 문자열로 바꿔 실제 경로 하나를 만든다 (보호 경로 침범 검사용 표본) */
export function sampleOfPattern(normalizedPattern: string): string {
  return normalizedPattern.replace(/\*\*\\?/g, '').replace(/[*?]+/g, 'x')
}
