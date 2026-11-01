import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ProgramRuleMatcher, validateProgramRule } from '../../src/main/programs/matcher.ts'
import {
  dedupe,
  parseEntries,
  parseEntry,
  parseEstimatedSize,
  parseInstallDate,
  parseInstallLocation,
  type ProgramRecord
} from '../../src/main/programs/parse.ts'
import {
  buildReadScript,
  parseReadOutput,
  READ_VALUE_NAMES,
  UNINSTALL_LOCATIONS,
  type RawUninstallEntry,
  type RegistryReader
} from '../../src/main/programs/registry.ts'
import { ProgramService, type ScanLocator } from '../../src/main/programs/service.ts'
import { buildRuleSet } from '../../src/main/rules/loader.ts'
import type { ProgramRule } from '../../src/shared/rules.ts'
import { TEST_ENV } from '../fixtures/ruleHelpers.ts'

function entry(
  values: Record<string, unknown>,
  scope: RawUninstallEntry['scope'] = 'machine',
  key = 'Key1'
): RawUninstallEntry {
  return { scope, key, values }
}

describe('레지스트리 읽기는 읽기 전용이다 (CLAUDE.md §5-9)', () => {
  const script = buildReadScript()

  it('읽기 전용 cmdlet 만 쓰고, 쓰기/삭제/실행 동작이 하나도 없다', () => {
    expect(script).toContain('Get-ChildItem')
    expect(script).toContain('Get-ItemProperty')
    const forbidden = [
      /\bSet-/i,
      /\bNew-ItemProperty/i,
      /\bNew-Item\b/i,
      /\bRemove-/i,
      /\bClear-/i,
      /\bRename-/i,
      /\bCopy-/i,
      /\bMove-/i,
      /\bInvoke-/i,
      /\bStart-/i,
      /\bStop-/i,
      /\bOut-File/i,
      /\bAdd-Content/i,
      /\breg(\.exe)?\s+(add|delete|import|copy|save|restore|load|unload)/i,
      /\bRegistry\.SetValue/i,
      /\bOpenSubKey\([^)]*true/i,
      /\bDeleteValue|\bDeleteSubKey/i
    ]
    for (const re of forbidden) expect(script, String(re)).not.toMatch(re)
  })

  it('Uninstall 위치 3곳(HKLM, HKLM WOW6432Node, HKCU)을 읽는다', () => {
    expect(UNINSTALL_LOCATIONS.map((l) => l.scope)).toEqual(['machine', 'machine-x86', 'user'])
    for (const l of UNINSTALL_LOCATIONS) expect(script).toContain(l.path)
    expect(script).toContain('WOW6432Node')
  })

  it('화면에 필요한 값 이름만 읽는다', () => {
    for (const n of READ_VALUE_NAMES) expect(script).toContain(`'${n}'`)
    expect(READ_VALUE_NAMES).not.toContain('DisplayIcon')
  })

  it('출력 JSON 파싱: BOM·빈 출력·단일 객체·이상한 항목을 견딘다', () => {
    const one = { scope: 'user', key: 'A', values: { DisplayName: 'A' } }
    expect(parseReadOutput('')).toEqual([])
    expect(parseReadOutput('\uFEFF' + JSON.stringify([one]))).toEqual([one])
    expect(parseReadOutput(JSON.stringify(one))).toEqual([one])
    const mixed = [
      one,
      null,
      'x',
      42,
      { scope: 'bogus', key: 'B', values: {} },
      { scope: 'user', key: '', values: {} },
      { scope: 'machine', key: 'C', values: null }
    ]
    expect(parseReadOutput(JSON.stringify(mixed))).toEqual([
      one,
      { scope: 'machine', key: 'C', values: {} }
    ])
    expect(() => parseReadOutput('not json')).toThrow()
  })
})

describe('값 해석 (누락/이상 형식에도 던지지 않는다)', () => {
  it('InstallDate: YYYYMMDD / YYYY-MM-DD 만, 존재하지 않는 날짜와 이상한 값은 없음', () => {
    expect(parseInstallDate('20240131')).toBe('2024-01-31')
    expect(parseInstallDate(20240131)).toBe('2024-01-31')
    expect(parseInstallDate('2024-01-31')).toBe('2024-01-31')
    for (const bad of [
      '20240230',
      '20241301',
      '00000000',
      '18000101',
      '3000-01-01',
      '1/31/2024',
      '',
      '   ',
      null,
      undefined,
      {},
      [],
      true,
      'abcd'
    ]) {
      expect(parseInstallDate(bad), String(bad)).toBeUndefined()
    }
  })

  it('EstimatedSize: KB → 바이트, 0/음수/NaN/문자/비정상적으로 큰 값은 없음', () => {
    expect(parseEstimatedSize(1024)).toBe(1024 * 1024)
    expect(parseEstimatedSize('2048')).toBe(2048 * 1024)
    for (const bad of [0, -5, NaN, Infinity, 'abc', '', null, undefined, {}, 4e12]) {
      expect(parseEstimatedSize(bad), String(bad)).toBeUndefined()
    }
  })

  it('InstallLocation: 따옴표·끝 구분자 정리, 드라이브 절대경로만 인정', () => {
    expect(parseInstallLocation('"C:\\Program Files\\App\\"')).toBe('C:\\Program Files\\App')
    expect(parseInstallLocation('C:\\Tools')).toBe('C:\\Tools')
    for (const bad of [
      'C:\\',
      'C:',
      'App',
      '..\\App',
      '\\\\server\\share\\App',
      'https://example.com',
      '',
      null,
      42,
      {}
    ]) {
      expect(parseInstallLocation(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('항목 해석 / 시스템 구성요소 / 중복 제거', () => {
  it('이름이 없거나 문자열이 아니면 목록에 올리지 않는다 (Windows 설정에도 안 나온다)', () => {
    for (const name of [undefined, '', '   ', 5, null, {}, []]) {
      expect(parseEntry(entry({ DisplayName: name })), String(name)).toBeNull()
    }
    expect(parseEntry(entry({}))).toBeNull()
  })

  it('값이 전부 이상해도 던지지 않고 이름만으로 항목을 만든다', () => {
    const r = parseEntry(
      entry({
        DisplayName: 'Odd App',
        Publisher: 123,
        DisplayVersion: {},
        InstallDate: 'zzz',
        InstallLocation: ['C:\\x'],
        EstimatedSize: 'big',
        UninstallString: 7,
        SystemComponent: 'maybe'
      })
    )
    expect(r).toMatchObject({ name: 'Odd App', isSystemComponent: false, scope: 'machine' })
    expect(r?.publisher).toBeUndefined()
    expect(r?.version).toBeUndefined()
    expect(r?.installDate).toBeUndefined()
    expect(r?.installLocation).toBeUndefined()
    expect(r?.estimatedSizeBytes).toBeUndefined()
    expect(r?.uninstallCommand).toBeUndefined()
  })

  it('정상 항목의 모든 필드를 읽는다', () => {
    const r = parseEntry(
      entry({
        DisplayName: '  My App ',
        Publisher: 'Me Inc.',
        DisplayVersion: '1.2.3',
        InstallDate: '20231225',
        InstallLocation: 'C:\\Program Files\\My App\\',
        EstimatedSize: 10240,
        UninstallString: '"C:\\Program Files\\My App\\unins000.exe"',
        QuietUninstallString: '"C:\\Program Files\\My App\\unins000.exe" /S'
      })
    )
    expect(r).toMatchObject({
      name: 'My App',
      publisher: 'Me Inc.',
      version: '1.2.3',
      installDate: '2023-12-25',
      installLocation: 'C:\\Program Files\\My App',
      estimatedSizeBytes: 10240 * 1024,
      isSystemComponent: false
    })
    expect(r?.uninstallCommand).toContain('unins000.exe')
    expect(r?.quietUninstallCommand).toContain('/S')
  })

  it('시스템 구성요소: SystemComponent=1, ParentKeyName, 업데이트/핫픽스 ReleaseType, KB 업데이트', () => {
    const sys = (v: Record<string, unknown>): boolean | undefined =>
      parseEntry(entry({ DisplayName: 'Thing', ...v }))?.isSystemComponent
    expect(sys({ SystemComponent: 1 })).toBe(true)
    expect(sys({ SystemComponent: '1' })).toBe(true)
    expect(sys({ SystemComponent: 0 })).toBe(false)
    expect(sys({ ParentKeyName: 'OperatingSystem' })).toBe(true)
    expect(sys({ ReleaseType: 'Security Update' })).toBe(true)
    expect(sys({ ReleaseType: 'Hotfix' })).toBe(true)
    expect(sys({ ReleaseType: 'Update' })).toBe(true)
    expect(sys({ ReleaseType: 'Beta' })).toBe(false)
    expect(
      parseEntry(entry({ DisplayName: 'Security Update for Microsoft Word 2016 (KB4011234)' }))
        ?.isSystemComponent
    ).toBe(true)
    expect(sys({})).toBe(false)
  })

  it('id 는 키 이름 + 위치(hive) 해시: 같은 키라도 위치가 다르면 id 가 다르고, 호출마다 같다', () => {
    const a = parseEntry(entry({ DisplayName: 'A' }, 'machine', '{GUID-1}'))
    const b = parseEntry(entry({ DisplayName: 'A' }, 'user', '{GUID-1}'))
    const a2 = parseEntry(entry({ DisplayName: 'A' }, 'machine', '{GUID-1}'))
    expect(a?.id).toBe(a2?.id)
    expect(a?.id).not.toBe(b?.id)
    expect(a?.id.startsWith('{GUID-1}#')).toBe(true)
  })

  it('중복 제거: 이름·게시자·버전이 같으면 하나로 합치고 machine 쪽을 유지, 빈 값은 채운다', () => {
    const base = { DisplayName: 'Dup App', Publisher: 'P', DisplayVersion: '1.0' }
    const out = parseEntries([
      entry({ ...base, EstimatedSize: 500 }, 'user', 'k3'),
      entry({ ...base, InstallLocation: 'C:\\Dup App' }, 'machine-x86', 'k2'),
      entry({ ...base }, 'machine', 'k1'),
      entry({ ...base, DisplayVersion: '2.0' }, 'machine', 'k4'),
      entry({ DisplayName: 'dup app', Publisher: 'p', DisplayVersion: '1.0' }, 'machine', 'k5')
    ])
    expect(out).toHaveLength(2)
    const v1 = out.find((r) => r.version === '1.0')
    expect(v1?.scope).toBe('machine')
    expect(v1?.installLocation).toBe('C:\\Dup App')
    expect(v1?.estimatedSizeBytes).toBe(500 * 1024)
    expect(out.find((r) => r.version === '2.0')).toBeDefined()
  })

  it('중복 중 하나라도 일반 프로그램이면 일반 프로그램으로 본다', () => {
    const a: ProgramRecord = { id: '1', name: 'X', isSystemComponent: true, scope: 'machine' }
    const b: ProgramRecord = { id: '2', name: 'X', isSystemComponent: false, scope: 'user' }
    expect(dedupe([a, b])[0]?.isSystemComponent).toBe(false)
  })

  it('한 항목이 이상해도 나머지는 계속 처리한다', () => {
    const hostile = entry({ DisplayName: 'Ok' })
    Object.defineProperty(hostile.values, 'Publisher', {
      get() {
        throw new Error('boom')
      },
      enumerable: true
    })
    const out = parseEntries([hostile, entry({ DisplayName: 'Fine' }, 'user', 'k9')])
    expect(out.map((r) => r.name)).toEqual(['Fine'])
  })
})

describe('프로그램 규칙 매처', () => {
  const rules: ProgramRule[] = [
    {
      id: 'r-contains',
      match: { nameContains: ['Visual C++', 'Redistributable'] },
      name: 'VC',
      category: 'redistributable',
      safety: 'caution',
      description: 'd',
      impact: 'i'
    },
    {
      id: 'r-publisher',
      match: { nameContains: ['driver'], publisherContains: ['nvidia', 'amd'] },
      name: 'GPU',
      category: 'driver',
      safety: 'protected',
      description: 'd',
      impact: 'i'
    },
    {
      id: 'r-regex',
      match: { nameRegex: '^node\\.js' },
      name: 'Node',
      category: 'dev-tool',
      safety: 'safe',
      description: 'd',
      impact: 'i'
    }
  ]
  const m = new ProgramRuleMatcher(rules)
  const facts = (name: string, publisher?: string, sys = false) => ({
    name,
    publisher,
    isSystemComponent: sys
  })

  it('nameContains 는 모두 포함해야 한다 (AND, 대소문자 무시)', () => {
    expect(m.match(facts('microsoft VISUAL C++ 2022 redistributable (x64)')).ruleId).toBe(
      'r-contains'
    )
    expect(m.match(facts('Visual C++ Build Tools')).safety).toBe('unknown')
  })

  it('publisherContains 는 하나라도 포함되면 되고, 다른 조건과 AND', () => {
    expect(m.match(facts('Graphics Driver 551', 'NVIDIA Corporation')).ruleId).toBe('r-publisher')
    expect(m.match(facts('Graphics Driver 551', 'Someone Else')).safety).toBe('unknown')
    expect(m.match(facts('Graphics Driver 551')).safety).toBe('unknown')
    expect(m.match(facts('Photo Editor', 'NVIDIA')).safety).toBe('unknown')
  })

  it('nameRegex 는 대소문자를 무시한다', () => {
    expect(m.match(facts('Node.js')).ruleId).toBe('r-regex')
    expect(m.match(facts('NODE.JS v20')).ruleId).toBe('r-regex')
    expect(m.match(facts('My Node.js Tool')).safety).toBe('unknown')
  })

  it('여러 규칙이 걸리면 보수적 안전도가 이긴다 (protected > caution > safe)', () => {
    const both = new ProgramRuleMatcher([
      { ...rules[2]!, id: 'a-safe', match: { nameContains: ['tool'] } },
      { ...rules[0]!, id: 'b-caution', match: { nameContains: ['tool'] } },
      { ...rules[1]!, id: 'c-protected', match: { nameContains: ['tool'] } }
    ])
    expect(both.match(facts('My Tool')).ruleId).toBe('c-protected')
    const two = new ProgramRuleMatcher([
      { ...rules[0]!, id: 'x-caution', match: { nameContains: ['tool'] } },
      { ...rules[2]!, id: 'y-safe', match: { nameContains: ['tool'] } }
    ])
    expect(two.match(facts('My Tool')).ruleId).toBe('x-caution')
  })

  it('규칙이 없으면 unknown, 시스템 구성요소면 caution', () => {
    expect(m.match(facts('Totally Unknown App'))).toMatchObject({ safety: 'unknown', ruleId: null })
    expect(m.match(facts('Totally Unknown App', undefined, true))).toMatchObject({
      safety: 'caution'
    })
  })

  it('프로그램 매칭 결과는 삭제 가능으로 표시되지 않는다 (cleanable/canDelete 는 항상 false)', () => {
    const r = m.match(facts('Node.js'))
    expect(r).toMatchObject({ cleanable: false, canDelete: false, source: 'builtin' })
  })

  it('조건이 없는 규칙과 잘못된 정규식은 거부한다 (모든 프로그램에 걸리는 것을 막는다)', () => {
    const empty = { ...rules[0]!, id: 'empty', match: {} }
    const emptyArrays = { ...rules[0]!, id: 'empty2', match: { nameContains: [] } }
    const badRegex = { ...rules[0]!, id: 'bad-re', match: { nameRegex: '([' } }
    expect(validateProgramRule(empty)?.code).toBe('invalid-pattern')
    expect(validateProgramRule(emptyArrays)?.code).toBe('invalid-pattern')
    expect(validateProgramRule(badRegex)?.code).toBe('invalid-pattern')
    expect(validateProgramRule(rules[0]!)).toBeNull()
    // 매처 자체도 이런 규칙을 무시한다
    const guarded = new ProgramRuleMatcher([empty, badRegex])
    expect(guarded.match(facts('Anything')).safety).toBe('unknown')
  })
})

describe('규칙 로더의 프로그램 규칙 검증', () => {
  const ctx = { env: TEST_ENV }
  const file = (programRules: unknown[]): unknown => ({
    schemaVersion: 1,
    rulesVersion: 't',
    pathRules: [],
    programRules
  })
  const good = {
    id: 'p-good',
    match: { nameContains: ['x'] },
    name: 'n',
    category: 'app',
    safety: 'safe',
    description: 'd',
    impact: 'i'
  }

  it('좋은 규칙은 통과, 형식/조건/정규식/중복 id 오류는 그 규칙만 거부', () => {
    const set = buildRuleSet(
      {
        builtin: file([
          good,
          { ...good, id: 'p-good' },
          { ...good, id: 'p-empty', match: {} },
          { ...good, id: 'p-badre', match: { nameRegex: '(' } },
          { ...good, id: 'p-badsafety', safety: 'unknown' },
          { ...good, id: 'P_Bad' },
          'junk'
        ])
      },
      ctx
    )
    expect(set.programRules.map((r) => r.id)).toEqual(['p-good'])
    const codes = Object.fromEntries(set.issues.map((i) => [i.ruleId, i.code]))
    expect(codes['p-empty']).toBe('invalid-pattern')
    expect(codes['p-badre']).toBe('invalid-pattern')
    expect(codes['p-badsafety']).toBe('schema')
    expect(codes['P_Bad']).toBe('schema')
    expect(
      set.issues.filter((i) => i.ruleId === 'p-good' && i.code === 'duplicate-id')
    ).toHaveLength(1)
  })
})

describe('시드 프로그램 규칙의 대표 이름', () => {
  const seed: unknown = JSON.parse(readFileSync('resources/cleanup-rules.json', 'utf8'))
  const set = buildRuleSet({ builtin: seed }, { env: TEST_ENV })
  const m = new ProgramRuleMatcher(set.programRules)
  const at = (name: string, publisher?: string) =>
    m.match({ name, publisher, isSystemComponent: false })

  it('시드 프로그램 규칙은 모두 로드된다', () => {
    expect(set.programRules.length).toBeGreaterThanOrEqual(11)
    expect(set.issues.filter((i) => i.ruleId.startsWith('prog-'))).toEqual([])
  })

  it.each([
    [
      'Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.38.33135',
      'prog-vcredist',
      'caution'
    ],
    ['Microsoft .NET Runtime - 8.0.4 (x64)', 'prog-dotnet', 'caution'],
    ['Microsoft Windows Desktop Runtime - 6.0.29 (x64)', 'prog-dotnet', 'caution'],
    ['Java(TM) SE Development Kit 17.0.2 (64-bit)', 'prog-java', 'caution'],
    ['Microsoft Edge WebView2 Runtime', 'prog-webview2', 'caution'],
    ['Microsoft Edge', 'prog-edge', 'protected'],
    ['NVIDIA 그래픽 드라이버 551.23', 'prog-nvidia-driver', 'protected'],
    ['Intel(R) Wireless Bluetooth(R)', 'prog-gpu-chipset-driver', 'protected'],
    ['Realtek High Definition Audio Driver', 'prog-gpu-chipset-driver', 'protected'],
    ['AhnLab Safe Transaction', 'prog-security-suite', 'caution'],
    ['Docker Desktop', 'prog-docker-desktop', 'caution'],
    ['Node.js', 'prog-nodejs', 'caution'],
    ['Unity Hub 3.7.0', 'prog-unity-hub-editor', 'safe']
  ])('"%s" → %s (%s)', (name, ruleId, safety) => {
    expect(at(name)).toMatchObject({ ruleId, safety })
  })

  it('Edge 규칙은 이름이 정확히 같을 때만 걸린다 (Edge 로 시작하는 다른 프로그램은 제외)', () => {
    expect(at('Microsoft Edge Dev').ruleId).not.toBe('prog-edge')
  })

  it('규칙이 없는 일반 프로그램은 unknown (제거는 사용자의 선택)', () => {
    expect(at('Notepad++ (64-bit x64)')).toMatchObject({ safety: 'unknown', ruleId: null })
  })
})

describe('ProgramService', () => {
  const fakeReader = (entries: RawUninstallEntry[]): RegistryReader & { calls: number } => ({
    calls: 0,
    readUninstallEntries() {
      this.calls++
      return Promise.resolve(entries)
    }
  })
  const matcher = new ProgramRuleMatcher([
    {
      id: 'r-node',
      match: { nameContains: ['node'] },
      name: 'Node',
      category: 'dev-tool',
      safety: 'caution',
      description: 'd',
      impact: 'i'
    }
  ])
  const entries = [
    entry(
      { DisplayName: 'Node.js', EstimatedSize: 1000, InstallLocation: 'C:\\Program Files\\nodejs' },
      'machine',
      'a'
    ),
    entry({ DisplayName: 'Big App', InstallLocation: 'C:\\Apps\\Big' }, 'machine', 'b'),
    entry({ DisplayName: 'Hidden Part', SystemComponent: 1 }, 'machine', 'c'),
    entry({ DisplayName: 'No Size No Place' }, 'user', 'd')
  ]
  const locator: ScanLocator = {
    locate: (p) => (p === 'C:\\Apps\\Big' ? { scanId: 's1', nodeId: '42', size: 5_000_000 } : null)
  }

  it('시스템 구성요소는 기본으로 숨기고, 규칙·용량·스캔 노드를 붙인다', async () => {
    const reader = fakeReader(entries)
    const svc = new ProgramService({ reader, matcher, scan: locator })
    const list = await svc.list(false, false)
    expect(list.map((p) => p.name).sort()).toEqual(['Big App', 'No Size No Place', 'Node.js'])
    const node = list.find((p) => p.name === 'Node.js')
    expect(node).toMatchObject({ sizeSource: 'registry', estimatedSizeBytes: 1000 * 1024 })
    expect(node?.match.ruleId).toBe('r-node')
    const big = list.find((p) => p.name === 'Big App')
    expect(big).toMatchObject({
      sizeSource: 'scan',
      estimatedSizeBytes: 5_000_000,
      scanNode: { scanId: 's1', nodeId: '42' }
    })
    const none = list.find((p) => p.name === 'No Size No Place')
    expect(none).toMatchObject({ sizeSource: 'unknown' })
    expect(none?.estimatedSizeBytes).toBeUndefined()
    expect((await svc.list(true, false)).map((p) => p.name)).toContain('Hidden Part')
  })

  it('제거는 아직 연결되지 않았다: canUninstall 은 항상 false, 제거 명령은 UI 로 나가지 않는다', async () => {
    const svc = new ProgramService({
      reader: fakeReader([entry({ DisplayName: 'App', UninstallString: '"C:\\x\\unins.exe"' })]),
      matcher
    })
    const [p] = await svc.list(true, false)
    expect(p?.canUninstall).toBe(false)
    expect(JSON.stringify(p)).not.toContain('unins')
    expect(Object.keys(p ?? {})).not.toContain('uninstallCommand')
  })

  it('목록은 캐시되고 refresh 때만 다시 읽는다, 동시 호출은 한 번만 읽는다', async () => {
    const reader = fakeReader(entries)
    const svc = new ProgramService({ reader, matcher })
    await Promise.all([svc.list(false, false), svc.list(true, false)])
    await svc.list(false, false)
    expect(reader.calls).toBe(1)
    await svc.list(false, true)
    expect(reader.calls).toBe(2)
  })

  it('레지스트리를 읽지 못하면 내부 정보 없이 INTERNAL 오류', async () => {
    const reader: RegistryReader = {
      readUninstallEntries: () => Promise.reject(new Error('C:\\secret powershell failure'))
    }
    const svc = new ProgramService({ reader, matcher, log: () => undefined })
    const err = await svc.list(false, false).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'INTERNAL' })
    expect(String((err as Error).message)).not.toContain('secret')
  })

  it('설치 폴더 힌트: 너무 얕은 경로(드라이브 바로 아래)는 제외', async () => {
    const svc = new ProgramService({
      reader: fakeReader([
        entry({ DisplayName: 'A', InstallLocation: 'C:\\Games' }, 'machine', 'a'),
        entry({ DisplayName: 'B', InstallLocation: 'C:\\Games\\B' }, 'machine', 'b')
      ]),
      matcher
    })
    await svc.load()
    expect(svc.installLocations()).toEqual(['C:\\Games\\B'])
  })

  it('programId 로만 설치 폴더를 찾는다 (모르는 ID/폴더 없는 프로그램은 NOT_FOUND)', async () => {
    const svc = new ProgramService({ reader: fakeReader(entries), matcher })
    const list = await svc.list(false, false)
    const node = list.find((p) => p.name === 'Node.js')!
    expect(await svc.installLocationOf(node.id)).toBe('C:\\Program Files\\nodejs')
    await expect(svc.installLocationOf('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const none = list.find((p) => p.name === 'No Size No Place')!
    await expect(svc.installLocationOf(none.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
