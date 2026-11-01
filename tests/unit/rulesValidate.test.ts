import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRuleSet } from '../../src/main/rules/loader.ts'
import { expandEnv, normalizeKey } from '../../src/main/rules/paths.ts'
import type { PathRule, RuleIssueCode } from '../../src/shared/rules.ts'
import { rule, TEST_ENV, withoutCleanup } from '../fixtures/ruleHelpers.ts'

const ctx = { env: TEST_ENV }

const file = (rules: unknown[]): unknown => ({
  schemaVersion: 1,
  rulesVersion: 'test',
  pathRules: rules,
  programRules: []
})

function load(rules: unknown[], user?: unknown[]) {
  return buildRuleSet({ builtin: file(rules), ...(user ? { user: file(user) } : {}) }, ctx)
}

function codes(rules: unknown[], user?: unknown[]): RuleIssueCode[] {
  return load(rules, user).issues.map((i) => i.code)
}

describe('규칙 검증 (DATA_SPEC §1.2) — 위반 규칙은 로드 거부', () => {
  it('기본 규칙은 통과한다 (다른 테스트의 기준선)', () => {
    const set = load([rule()])
    expect(set.issues).toEqual([])
    expect(set.counts.builtin).toBe(1)
  })

  it('1. cleanable 인데 safety 가 protected 면 거부', () => {
    expect(codes([rule({ safety: 'protected' })])).toEqual(['cleanable-protected'])
  })

  it('2. cleanable 인데 cleanup 이 없으면 거부', () => {
    const noCleanup = withoutCleanup(rule())
    expect(codes([noCleanup])).toEqual(['cleanup-missing'])
  })

  it('3. allowPermanent 인데 category 가 temp/cache 가 아니면 거부 (log/dump 포함)', () => {
    for (const category of ['log', 'dump', 'update', 'dev-cache', 'other'] as const) {
      const base = rule({ category })
      const bad = {
        ...base,
        cleanup: { ...(base.cleanup as NonNullable<PathRule['cleanup']>), allowPermanent: true }
      }
      expect(codes([bad]), category).toEqual(['permanent-category'])
    }
    // temp / cache 는 허용
    for (const category of ['temp', 'cache'] as const) {
      const base = rule({ category })
      const ok = {
        ...base,
        cleanup: { ...(base.cleanup as NonNullable<PathRule['cleanup']>), allowPermanent: true }
      }
      expect(codes([ok]), category).toEqual([])
    }
  })

  it('4. defaultSelected 인데 safety 가 safe 가 아니면 거부', () => {
    const base = rule({ safety: 'caution' })
    const bad = {
      ...base,
      cleanup: { ...(base.cleanup as NonNullable<PathRule['cleanup']>), defaultSelected: true }
    }
    expect(codes([bad])).toEqual(['default-selected-not-safe'])
    const safeOk = {
      ...rule(),
      cleanup: { ...(rule().cleanup as NonNullable<PathRule['cleanup']>), defaultSelected: true }
    }
    expect(codes([safeOk])).toEqual([])
  })

  it('5. cleanable 규칙이 보호 경로 안에 있고 §5 예외가 아니면 거부', () => {
    const targets = [
      '%WINDIR%\\System32\\Foo',
      '%WINDIR%\\Prefetch',
      '%PROGRAMFILES%\\SomeApp\\Cache',
      '%PROGRAMFILES(X86)%\\Steam\\appcache',
      '%PROGRAMDATA%\\Microsoft\\Windows Defender',
      '%USERPROFILE%\\Documents\\cache',
      '%USERPROFILE%\\Downloads',
      '%USERPROFILE%\\.ssh',
      '%SYSTEMDRIVE%\\System Volume Information',
      '%SYSTEMDRIVE%\\Recovery'
    ]
    for (const pattern of targets) {
      expect(codes([rule({ match: { kind: 'prefix', pattern } })]), pattern).toEqual([
        'protected-path'
      ])
    }
    // 모든 사용자의 Documents 를 가리키는 glob 도 어느 쪽 사유로든 거부된다 (고정 부분이 Users 라 "너무 넓음")
    expect(
      codes([rule({ match: { kind: 'glob', pattern: '%SYSTEMDRIVE%\\Users\\*\\Documents' } })])
    ).toEqual(['too-broad'])
  })

  it('5. SAFETY §5 에 열거된 예외(Windows\\Temp 등)는 허용', () => {
    for (const pattern of [
      '%WINDIR%\\Temp',
      '%WINDIR%\\SoftwareDistribution\\Download',
      '%WINDIR%\\Logs\\CBS',
      '%WINDIR%\\Minidump'
    ]) {
      expect(codes([rule({ match: { kind: 'prefix', pattern } })]), pattern).toEqual([])
    }
  })

  it('5. 휴지통은 전용 동작(empty-recycle-bin)일 때만 예외', () => {
    const match = { kind: 'prefix', pattern: '%SYSTEMDRIVE%\\$Recycle.Bin' } as const
    expect(codes([rule({ match })])).toEqual(['protected-path'])
    const withAction = {
      ...rule({ match, safety: 'caution' }),
      cleanup: {
        ...(rule().cleanup as NonNullable<PathRule['cleanup']>),
        specialAction: 'empty-recycle-bin' as const
      }
    }
    expect(codes([withAction])).toEqual([])
    // 다른 전용 동작으로는 예외가 되지 않는다
    const wrongAction = {
      ...withAction,
      cleanup: { ...withAction.cleanup, specialAction: 'run-disk-cleanup' as const }
    }
    expect(codes([wrongAction])).toEqual(['protected-path'])
  })

  it('5. 경계 확인: 이름만 비슷한 폴더(Windows.old, Windows2)는 보호 구역이 아니다', () => {
    for (const pattern of ['%SYSTEMDRIVE%\\Windows.old', '%SYSTEMDRIVE%\\Windows2\\Cache']) {
      expect(codes([rule({ match: { kind: 'prefix', pattern } })]), pattern).toEqual([])
    }
  })

  it('6. cleanable 규칙의 패턴이 지나치게 넓으면 거부', () => {
    const broad: Array<PathRule['match']> = [
      { kind: 'prefix', pattern: '%SYSTEMDRIVE%\\' },
      { kind: 'prefix', pattern: 'C:\\' },
      { kind: 'prefix', pattern: '%SYSTEMDRIVE%\\Users' },
      { kind: 'prefix', pattern: '%USERPROFILE%' },
      { kind: 'prefix', pattern: '%LOCALAPPDATA%' },
      { kind: 'prefix', pattern: '%APPDATA%' },
      { kind: 'prefix', pattern: '%USERPROFILE%\\AppData' },
      { kind: 'glob', pattern: '%USERPROFILE%\\**\\Cache' },
      { kind: 'glob', pattern: '**\\Cache' },
      { kind: 'name', pattern: 'Cache' }
    ]
    for (const match of broad) {
      expect(codes([rule({ match })]), match.pattern).toEqual(['too-broad'])
    }
  })

  it('6. 표시 전용(cleanable:false) 규칙은 넓어도 허용 — 정보 제공용', () => {
    const rules = [
      rule({ id: 'a', cleanable: false, match: { kind: 'name', pattern: 'node_modules' } }),
      rule({
        id: 'b',
        cleanable: false,
        match: { kind: 'glob', pattern: '**\\steamapps\\common' }
      }),
      rule({
        id: 'c',
        cleanable: false,
        safety: 'protected',
        match: { kind: 'exact', pattern: '%USERPROFILE%' }
      })
    ].map(withoutCleanup)
    expect(codes(rules)).toEqual([])
  })

  it('7. 같은 id 가 중복되면 뒤의 규칙을 거부하고 앞의 규칙은 유지', () => {
    const first = rule({ name: '먼저' })
    const second = rule({
      name: '나중',
      match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Other' }
    })
    const set = load([first, second])
    expect(set.issues.map((i) => i.code)).toEqual(['duplicate-id'])
    expect(set.counts.builtin).toBe(1)
    expect(set.matcher.lookup('C:\\Users\\tester\\AppData\\Local\\TestApp\\Cache').match.name).toBe(
      '먼저'
    )
    expect(set.matcher.lookup('C:\\Users\\tester\\AppData\\Local\\Other').match.ruleId).toBeNull()
  })

  it('7. 사용자 규칙이 내장 규칙과 같은 id 면 무시', () => {
    const set = load([rule()], [rule({ name: '사용자 버전' })])
    expect(set.issues.map((i) => i.code)).toEqual(['duplicate-id'])
    expect(set.counts).toEqual({ builtin: 1, user: 0 })
  })

  it('8. 사용자 규칙은 내장 protected 의 안전도를 낮출 수 없다 (로드 거부)', () => {
    const builtin = [
      rule({
        id: 'sys-thing',
        cleanable: false,
        safety: 'protected',
        match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Vault' }
      })
    ].map(withoutCleanup)
    const user = [
      rule({
        id: 'my-vault',
        cleanable: false,
        safety: 'safe',
        match: { kind: 'exact', pattern: '%LOCALAPPDATA%\\Vault\\data' }
      })
    ].map(withoutCleanup)
    expect(codes(builtin, user)).toEqual(['protected-downgrade'])
  })

  it('8. 하드코딩 보호 경로(문서 폴더 등)도 사용자 규칙으로 낮출 수 없다', () => {
    const user = [
      rule({
        id: 'my-docs',
        cleanable: false,
        safety: 'caution',
        match: { kind: 'prefix', pattern: '%USERPROFILE%\\Documents\\Projects' }
      })
    ].map(withoutCleanup)
    expect(codes([], user)).toEqual(['protected-downgrade'])
  })

  it('8. 사용자 규칙으로 protected 를 더 높이는 것(또는 같은 수준)은 허용', () => {
    const user = [
      rule({
        id: 'my-secret',
        cleanable: false,
        safety: 'protected',
        match: { kind: 'prefix', pattern: '%USERPROFILE%\\Documents\\Secret' }
      })
    ].map(withoutCleanup)
    expect(codes([], user)).toEqual([])
  })

  it('사용자 규칙은 관리자 권한/전용 동작 항목을 만들 수 없다', () => {
    const base = rule()
    const admin = {
      ...base,
      id: 'u-admin',
      cleanup: { ...(base.cleanup as NonNullable<PathRule['cleanup']>), requiresAdmin: true }
    }
    expect(codes([], [admin])).toEqual(['user-privileged'])
  })

  it('사용자 규칙도 1~6 검증을 똑같이 받는다', () => {
    expect(codes([], [rule({ id: 'u1', safety: 'protected' })])).toEqual(['cleanable-protected'])
    expect(
      codes([], [rule({ id: 'u2', match: { kind: 'prefix', pattern: '%WINDIR%\\System32' } })])
    ).toEqual(['protected-path'])
  })
})

describe('규칙 구조 오류와 파일 단위 오류', () => {
  it('잘못된 규칙 하나만 거부하고 나머지는 로드한다', () => {
    const set = load([
      rule({ id: 'ok-one' }),
      { id: 'broken', name: '필드 부족' },
      rule({ id: 'ok-two', match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Two' } })
    ])
    expect(set.issues.map((i) => [i.ruleId, i.code])).toEqual([['broken', 'schema']])
    expect(set.counts.builtin).toBe(2)
  })

  it('safety 에 unknown 을 쓰면 거부 (규칙 없음 상태이므로)', () => {
    expect(codes([{ ...rule(), safety: 'unknown' }])).toEqual(['schema'])
  })

  it('알 수 없는 필드와 잘못된 id 형식은 거부', () => {
    expect(codes([{ ...rule(), extra: 1 }])).toEqual(['schema'])
    expect(codes([rule({ id: 'Bad_ID' })])).toEqual(['schema'])
  })

  it('허용되지 않은 환경변수/상대 경로/와일드카드 위치는 invalid-pattern', () => {
    expect(codes([rule({ match: { kind: 'prefix', pattern: '%TEMP%\\x' } })])).toEqual([
      'invalid-pattern'
    ])
    expect(codes([rule({ match: { kind: 'prefix', pattern: 'Users\\x' } })])).toEqual([
      'invalid-pattern'
    ])
    expect(codes([rule({ match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\*' } })])).toEqual([
      'invalid-pattern'
    ])
    expect(codes([rule({ match: { kind: 'name', pattern: 'a\\b' } })])).toEqual(['invalid-pattern'])
  })

  it('파일 구조(schemaVersion)가 틀리면 규칙 없이 계속 동작', () => {
    const set = buildRuleSet({ builtin: { schemaVersion: 2, pathRules: [] } }, ctx)
    expect(set.issues[0]?.code).toBe('schema')
    expect(set.counts.builtin).toBe(0)
    expect(set.matcher.lookup('C:\\x').match.safety).toBe('unknown')
  })
})

describe('환경변수 확장/경로 정규화', () => {
  it('허용된 변수만 확장하고 대소문자를 구분하지 않는다', () => {
    expect(expandEnv('%localappdata%\\x', TEST_ENV)).toEqual({
      ok: true,
      value: 'C:\\Users\\tester\\AppData\\Local\\x'
    })
    expect(expandEnv('%PROGRAMFILES(X86)%\\y', TEST_ENV)).toEqual({
      ok: true,
      value: 'C:\\Program Files (x86)\\y'
    })
    expect(expandEnv('%TEMP%\\x', { ...TEST_ENV, TEMP: 'C:\\t' })).toEqual({
      ok: false,
      variable: 'TEMP'
    })
    expect(expandEnv('%APPDATA%', {})).toEqual({ ok: false, variable: 'APPDATA' })
  })

  it('슬래시·\\\\?\\ 접두사·중복 구분자·끝 구분자·대소문자를 통일한다', () => {
    expect(normalizeKey('C:/Users//Tester/')).toBe('c:\\users\\tester')
    expect(normalizeKey('\\\\?\\C:\\Windows\\')).toBe('c:\\windows')
    expect(normalizeKey('C:')).toBe('c:\\')
    expect(normalizeKey('C:\\')).toBe('c:\\')
  })
})

describe('시드 규칙 (resources/cleanup-rules.json)', () => {
  const seed: unknown = JSON.parse(readFileSync('resources/cleanup-rules.json', 'utf8'))

  it('모든 시드 규칙이 검증을 통과한다 (거부 0건)', () => {
    const set = buildRuleSet({ builtin: seed }, ctx)
    expect(set.issues).toEqual([])
    expect(set.counts.builtin).toBeGreaterThan(60)
    expect(set.programRules.length).toBeGreaterThan(0)
  })

  it('정리 가능 시드 규칙 중 영구 삭제 허용은 temp/cache 뿐이고, 기본 선택은 safe 뿐이다', () => {
    const rules = (seed as { pathRules: PathRule[] }).pathRules
    for (const r of rules) {
      if (r.cleanup?.allowPermanent) expect(['temp', 'cache'], r.id).toContain(r.category)
      if (r.cleanup?.defaultSelected) expect(r.safety, r.id).toBe('safe')
      if (r.cleanable) expect(r.safety, r.id).not.toBe('protected')
    }
  })
})
