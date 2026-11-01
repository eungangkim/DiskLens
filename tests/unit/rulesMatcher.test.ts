import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRuleSet } from '../../src/main/rules/loader.ts'
import type { PathRule } from '../../src/shared/rules.ts'
import { rule, TEST_ENV, withoutCleanup } from '../fixtures/ruleHelpers.ts'

const ctx = { env: TEST_ENV }
const L = 'C:\\Users\\tester\\AppData\\Local'

/** 표시 전용 규칙 (cleanup 없음) 만들기 */
function view(
  id: string,
  kind: PathRule['match']['kind'],
  pattern: string,
  safety: PathRule['safety'],
  extra: Partial<PathRule> = {}
): PathRule {
  return withoutCleanup(
    rule({
      id,
      name: `규칙 ${id}`,
      cleanable: false,
      safety,
      match: { kind, pattern },
      ...extra
    })
  )
}

function matcher(rules: PathRule[], user: PathRule[] = []) {
  const set = buildRuleSet(
    {
      builtin: { schemaVersion: 1, rulesVersion: 't', pathRules: rules },
      ...(user.length ? { user: { schemaVersion: 1, rulesVersion: 't', pathRules: user } } : {})
    },
    ctx
  )
  expect(set.issues).toEqual([])
  return set.matcher
}

describe('매처: 우선순위 (구체성)', () => {
  it('exact > 긴 prefix > 짧은 prefix', () => {
    const m = matcher([
      view('short', 'prefix', `${L}\\App`, 'caution'),
      view('long', 'prefix', `${L}\\App\\Data`, 'safe'),
      view('exact', 'exact', `${L}\\App\\Data\\keep`, 'protected')
    ])
    expect(m.lookup(`${L}\\App\\x`).match.ruleId).toBe('short')
    expect(m.lookup(`${L}\\App\\Data\\x\\y`).match.ruleId).toBe('long')
    expect(m.lookup(`${L}\\App\\Data\\keep`).match.ruleId).toBe('exact')
    // exact 는 자기 자신만: 그 하위는 긴 prefix 규칙이 판정한다
    expect(m.lookup(`${L}\\App\\Data\\keep\\sub`).match.ruleId).toBe('long')
  })

  it('glob 이 더 구체적이면 짧은 prefix 보다 우선한다 (Chrome 프로필 vs Cache)', () => {
    const m = matcher([
      view('profile', 'prefix', `${L}\\Google\\Chrome\\User Data`, 'protected'),
      view('cache', 'glob', `${L}\\Google\\Chrome\\User Data\\*\\Cache`, 'safe')
    ])
    const cache = m.lookup(`${L}\\Google\\Chrome\\User Data\\Profile 2\\Cache`)
    expect(cache.match.ruleId).toBe('cache')
    expect(cache.root).toBe(true)
    // 캐시 하위는 규칙을 물려받지만 규칙 루트는 아니다
    const inner = m.lookup(`${L}\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data`)
    expect(inner.match.ruleId).toBe('cache')
    expect(inner.root).toBe(false)
    // 쿠키 등 나머지는 프로필(보호)
    expect(m.lookup(`${L}\\Google\\Chrome\\User Data\\Default\\Cookies`).match.safety).toBe(
      'protected'
    )
  })

  it('name 규칙은 위치 무관하지만 prefix/glob 보다 약하다', () => {
    const m = matcher([
      view('nm', 'name', 'node_modules', 'caution'),
      view('docs', 'prefix', 'C:\\Users\\tester\\Documents', 'protected')
    ])
    expect(m.lookup('C:\\dev\\app\\node_modules').match.ruleId).toBe('nm')
    expect(m.lookup('C:\\dev\\app\\node_modules').root).toBe(true)
    expect(m.lookup('C:\\dev\\app\\node_modules\\react\\lib').root).toBe(false)
    expect(m.lookup('C:\\dev\\app\\node_modules\\react\\lib').match.ruleId).toBe('nm')
    // 보호 prefix 안의 node_modules 는 보호가 이긴다
    expect(m.lookup('C:\\Users\\tester\\Documents\\p\\node_modules').match.safety).toBe('protected')
  })

  it('구체성이 같으면 더 보수적인 안전도가 이긴다 (protected > caution > safe)', () => {
    const m = matcher([
      view('a-safe', 'prefix', `${L}\\Same`, 'safe'),
      view('b-caution', 'prefix', `${L}\\Same`, 'caution')
    ])
    expect(m.lookup(`${L}\\Same\\x`).match.safety).toBe('caution')
    const m2 = matcher([
      view('a', 'glob', `${L}\\*\\Dup`, 'caution'),
      view('b', 'glob', `${L}\\*\\Dup`, 'protected'),
      view('c', 'glob', `${L}\\*\\Dup`, 'safe')
    ])
    expect(m2.lookup(`${L}\\Z\\Dup`).match.safety).toBe('protected')
  })

  it('선언 순서는 결과에 영향을 주지 않는다', () => {
    const rs = [
      view('x', 'prefix', `${L}\\Same`, 'safe'),
      view('y', 'prefix', `${L}\\Same`, 'caution')
    ]
    expect(matcher(rs).lookup(`${L}\\Same`).match.safety).toBe(
      matcher([...rs].reverse()).lookup(`${L}\\Same`).match.safety
    )
  })
})

describe('매처: 경로 경계/정규화', () => {
  const m = matcher([view('t', 'prefix', 'C:\\Temp', 'safe')])

  it('prefix 는 경계 `\\` 를 확인한다 (C:\\Temp2 는 C:\\Temp 가 아니다)', () => {
    expect(m.lookup('C:\\Temp').match.ruleId).toBe('t')
    expect(m.lookup('C:\\Temp\\a').match.ruleId).toBe('t')
    expect(m.lookup('C:\\Temp2').match.ruleId).toBeNull()
    expect(m.lookup('C:\\Temp2\\a').match.ruleId).toBeNull()
    expect(m.lookup('C:\\Tem').match.ruleId).toBeNull()
  })

  it('대소문자 무시, 슬래시/끝 구분자/중복 구분자 정규화', () => {
    for (const p of [
      'c:\\temp\\A',
      'C:/Temp/A',
      'C:\\Temp\\A\\',
      'C:\\\\Temp\\\\A',
      '\\\\?\\C:\\TEMP\\a'
    ]) {
      expect(m.lookup(p).match.ruleId, p).toBe('t')
    }
  })

  it('규칙이 없으면 unknown, 삭제 불가', () => {
    const r = m.lookup('C:\\Other\\thing')
    expect(r.match).toMatchObject({
      ruleId: null,
      safety: 'unknown',
      cleanable: false,
      canDelete: false
    })
  })

  it('glob: * 는 한 구간, ** 는 여러 구간, ? 는 한 글자', () => {
    const g = matcher([
      view('one', 'glob', 'C:\\a\\*\\z', 'safe'),
      view('deep', 'glob', 'C:\\b\\**\\z', 'caution'),
      view('q', 'glob', 'C:\\c\\f?le', 'protected')
    ])
    expect(g.lookup('C:\\a\\x\\z').match.ruleId).toBe('one')
    expect(g.lookup('C:\\a\\x\\y\\z').match.ruleId).toBeNull()
    expect(g.lookup('C:\\b\\z').match.ruleId).toBe('deep')
    expect(g.lookup('C:\\b\\x\\y\\w\\z').match.ruleId).toBe('deep')
    expect(g.lookup('C:\\c\\file').match.ruleId).toBe('q')
    expect(g.lookup('C:\\c\\fle').match.ruleId).toBeNull()
  })
})

describe('매처: 하드코딩 보호 경로 표시 (SAFETY §2, §3)', () => {
  const m = matcher([])

  it('규칙이 없어도 시스템/개인 폴더는 🔴 protected 로 표시된다', () => {
    for (const p of [
      'C:\\',
      'C:\\Users',
      'C:\\Users\\tester',
      'C:\\Users\\other',
      'C:\\Users\\tester\\AppData',
      'C:\\Users\\tester\\AppData\\Local',
      'C:\\Users\\tester\\Documents\\notes',
      'C:\\Users\\tester\\Downloads',
      'C:\\Users\\tester\\.ssh\\id_rsa',
      'C:\\Windows\\System32',
      'C:\\Program Files\\App',
      'C:\\Program Files (x86)\\App\\bin',
      'C:\\ProgramData\\Foo',
      'C:\\pagefile.sys',
      'C:\\Users\\tester\\NTUSER.DAT.LOG1'
    ]) {
      const r = m.lookup(p).match
      expect(r.safety, p).toBe('protected')
      expect(r.canDelete, p).toBe(false)
    }
  })

  it('보호 구역이 아닌 곳은 규칙이 없으면 unknown', () => {
    for (const p of [
      'C:\\dev',
      'C:\\Users\\tester\\AppData\\Local\\Foo',
      'C:\\Users\\tester\\.vscode',
      'C:\\Windows.old',
      'C:\\Windowsx'
    ]) {
      expect(m.lookup(p).match.safety, p).toBe('unknown')
    }
  })

  it('이 앱 자신의 폴더도 보호 구역', () => {
    const set = buildRuleSet(
      { builtin: { schemaVersion: 1, rulesVersion: 't', pathRules: [] } },
      { env: TEST_ENV, appPaths: ['C:\\Users\\tester\\AppData\\Roaming\\disklens'] }
    )
    expect(
      set.matcher.lookup('C:\\Users\\tester\\AppData\\Roaming\\DiskLens\\scan-cache').match.safety
    ).toBe('protected')
  })

  it('보호 구역 안의 느슨한 규칙은 🔴 가 이긴다 (표시 전용 caution 규칙 포함)', () => {
    const mm = matcher([view('nm', 'name', 'node_modules', 'caution')])
    expect(mm.lookup('C:\\Users\\tester\\Documents\\p\\node_modules').match.safety).toBe(
      'protected'
    )
    // 보호 구역 밖이면 규칙이 그대로 적용된다
    expect(mm.lookup('C:\\dev\\p\\node_modules').match.safety).toBe('caution')
  })

  it('§5 정리 허용 예외(Windows\\Temp)는 규칙이 설명한다', () => {
    const mm = matcher([
      rule({ id: 'sys-temp', match: { kind: 'prefix', pattern: '%WINDIR%\\Temp' } })
    ])
    expect(mm.lookup('C:\\Windows\\Temp\\foo.tmp').match.ruleId).toBe('sys-temp')
    expect(mm.lookup('C:\\Windows\\Temp\\foo.tmp').match.safety).toBe('safe')
    expect(mm.lookup('C:\\Windows\\System32').match.safety).toBe('protected')
  })
})

describe('매처: 사용자 규칙은 protected 를 낮출 수 없다 (매칭 시점)', () => {
  it('내장이 protected 로 판정한 경로에서는 더 구체적인 사용자 규칙도 무시된다', () => {
    // 로드 시점 검사를 우회하는 name 규칙으로 시도: 보호 prefix 아래의 node_modules 를 safe 로
    const builtin = [view('docs', 'prefix', 'C:\\Vault', 'protected')]
    const user = [view('u-nm', 'name', 'cache-dir', 'safe', { id: 'u-nm' })]
    const m = matcher(builtin, user)
    expect(m.lookup('C:\\Vault\\a\\cache-dir').match.safety).toBe('protected')
    expect(m.lookup('C:\\Vault\\a\\cache-dir').match.source).toBe('builtin')
    // 보호 밖에서는 사용자 규칙이 동작하고 source 가 user 로 표시된다
    expect(m.lookup('C:\\x\\cache-dir').match).toMatchObject({
      ruleId: 'u-nm',
      source: 'user',
      safety: 'safe'
    })
  })

  it('사용자 규칙으로 보호 수준을 높이는 것은 가능', () => {
    const builtin = [view('c', 'prefix', 'C:\\Games', 'caution')]
    const user = [view('u-save', 'prefix', 'C:\\Games\\Saves', 'protected', { id: 'u-save' })]
    const m = matcher(builtin, user)
    expect(m.lookup('C:\\Games\\Saves\\a').match.safety).toBe('protected')
    expect(m.lookup('C:\\Games\\Other').match.safety).toBe('caution')
  })
})

describe('매처: 합성 행과 스캔 힌트', () => {
  it('lookupChild: 상속되는 규칙만 합성 행에 적용된다', () => {
    const m = matcher([
      view('p', 'prefix', 'C:\\Cache', 'safe'),
      view('e', 'exact', 'C:\\Exact', 'caution')
    ])
    expect(m.lookupChild('C:\\Cache').ruleId).toBe('p')
    expect(m.lookupChild('C:\\Cache\\sub').ruleId).toBe('p')
    expect(m.lookupChild('C:\\Exact').ruleId).toBeNull() // exact 는 자기 자신만
    expect(m.lookupChild('C:\\Nothing').safety).toBe('unknown')
  })

  it('scanHints: exact/prefix 경로와 name 이름만 접지 않을 대상으로 제공 (glob 제외)', () => {
    const m = matcher([
      view('p', 'prefix', `${L}\\App`, 'safe'),
      view('e', 'exact', 'C:\\Exact', 'caution'),
      view('g', 'glob', `${L}\\*\\Cache`, 'safe'),
      view('n', 'name', 'node_modules', 'caution')
    ])
    const h = m.scanHints()
    expect(h.keepNames).toEqual(['node_modules'])
    expect(h.keepPaths.sort()).toEqual([`${L}\\App`, 'C:\\Exact'].sort())
  })

  it('RuleMatch 에는 설명·영향·카테고리·cleanable 이 담기고 canDelete 는 항상 false (삭제 관문은 6단계)', () => {
    const m = matcher([rule({ id: 'c1', match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Z' } })])
    expect(m.lookup(`${L}\\Z`).match).toEqual({
      ruleId: 'c1',
      source: 'builtin',
      name: '테스트 캐시',
      safety: 'safe',
      category: 'cache',
      description: '테스트용 캐시입니다.',
      impact: '다시 만들어집니다.',
      cleanable: true,
      canDelete: false
    })
  })
})

describe('시드 규칙의 대표 경로 (완료 기준: 올바른 설명/안전도로 표시)', () => {
  const seed: unknown = JSON.parse(readFileSync('resources/cleanup-rules.json', 'utf8'))
  const set = buildRuleSet({ builtin: seed }, ctx)
  const at = (p: string) => set.matcher.lookup(p).match

  it.each([
    ['C:\\Users\\tester\\AppData\\Local\\Temp\\abc.tmp', 'win-user-temp', 'safe'],
    ['C:\\Windows\\Temp', 'win-system-temp', 'safe'],
    ['C:\\Windows\\SoftwareDistribution\\Download\\x', 'win-update-download', 'caution'],
    ['C:\\Windows.old', 'win-old', 'caution'],
    ['C:\\$Recycle.Bin', 'recycle-bin', 'caution'],
    [
      'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
      'chrome-cache',
      'safe'
    ],
    [
      'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies',
      'chrome-profile',
      'protected'
    ],
    ['C:\\Users\\tester\\AppData\\Local\\npm-cache\\_cacache', 'npm-cache', 'safe'],
    ['C:\\Users\\tester\\AppData\\Local\\D3DSCache', 'd3d-shader-cache', 'safe'],
    ['C:\\Users\\tester\\AppData\\Roaming\\Code\\Cache', 'vscode-cache', 'safe'],
    [
      'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\settings.json',
      'vscode-user-data',
      'caution'
    ],
    ['C:\\dev\\app\\node_modules', 'dev-node-modules', 'caution'],
    ['C:\\Windows\\WinSxS', 'sys-winsxs', 'protected'],
    ['C:\\pagefile.sys', 'sys-pagefile', 'protected'],
    ['C:\\Users\\tester\\Documents', 'user-documents', 'protected'],
    ['C:\\Users\\tester\\AppData\\Local\\Docker\\wsl\\disk', 'vm-docker', 'protected']
  ] as const)('%s → %s (%s)', (path, ruleId, safety) => {
    const r = at(path)
    expect(r.safety).toBe(safety)
    if (ruleId) expect(r.ruleId).toBe(ruleId)
  })

  it('표시 전용 규칙(node_modules)과 보호 규칙은 정리 불가, 정리 가능 규칙은 cleanable', () => {
    expect(at('C:\\dev\\app\\node_modules').cleanable).toBe(false)
    expect(at('C:\\Windows\\WinSxS').cleanable).toBe(false)
    expect(at('C:\\Users\\tester\\AppData\\Local\\Temp').cleanable).toBe(true)
  })

  it('규칙마다 설명(description)과 영향(impact)이 있다', () => {
    for (const r of set.matcher.rules) {
      expect(r.rule.description.length, r.rule.id).toBeGreaterThan(5)
      expect(r.rule.impact.length, r.rule.id).toBeGreaterThan(5)
    }
  })
})
