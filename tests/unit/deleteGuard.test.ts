// 삭제 관문/확인 토큰 테스트 (TEST_PLAN.md §4.4 "거부되어야 하는 케이스"). 모든 경로는 샌드박스(임시 폴더의 가짜 드라이브) 안이다.
// guard.evaluate / guard.check 는 판정만 하며 아무것도 지우지 않는다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfirmationStore,
  ExecutionPermit,
  isIssuedPermit
} from '../../src/main/safety/confirmation.ts'
import { judgeRule } from '../../src/main/safety/deleteGuard.ts'
import type { FsReader } from '../../src/main/safety/fsReader.ts'
import { nodeFsReader } from '../../src/main/safety/fsReader.ts'
import { MAX_PATH_LENGTH, sanitizeRawPath } from '../../src/main/safety/rawPath.ts'
import type { LoadedRule } from '../../src/main/rules/matcher.ts'
import type { PathRule } from '../../src/shared/rules.ts'
import { buildEngine } from '../fixtures/deleteEngine.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'
import { rule, withoutCleanup } from '../fixtures/ruleHelpers.ts'

const CACHE = 'Users\\tester\\AppData\\Local\\TestApp\\Cache'

let sb: Sandbox
beforeEach(() => {
  sb = createSandbox()
})
afterEach(() => sb.dispose())

/** 확인 단계를 거친 permit 을 만든다 (진짜 ConfirmationStore 경로) */
function permitFor(
  itemIds: string[],
  mode: 'trash' | 'permanent' = 'trash',
  acknowledgeCaution = false
): ExecutionPermit {
  const store = new ConfirmationStore()
  const t = store.issue({ planId: 'p1', digest: 'd1' })
  const result = store.consume({
    planId: 'p1',
    confirmationId: t.confirmationId,
    digest: 'd1',
    mode,
    itemIds,
    needsCautionAck: false,
    acknowledgeCaution
  })
  if (!result.ok) throw new Error('permit 생성 실패')
  return result.permit
}

function setup(rules: PathRule[] = [rule()], options = {}) {
  const e = buildEngine(sb, rules, options)
  const loaded = (id = 'test-cache'): LoadedRule => {
    const r = e.rules.find((x) => x.rule.id === id)
    if (!r) throw new Error(`규칙 없음: ${id}`)
    return r
  }
  const check = (path: string, mode: 'trash' | 'permanent' = 'trash', id = 'test-cache') =>
    e.guard.check({ path, rule: loaded(id), mode, permit: permitFor([id], mode, true) })
  return { ...e, loaded, check }
}

describe('sanitizeRawPath — 경로 문자열 검증', () => {
  it.each([
    ['빈 문자열', ''],
    ['널 문자', 'C:\\Temp\\a\0b'],
    ['상대 경로', 'Temp\\a'],
    ['UNC', '\\\\server\\share\\a'],
    ['확장 UNC', '\\\\?\\UNC\\server\\share\\a'],
    ['장치 경로', '\\\\.\\C:\\a'],
    ['드라이브 없는 루트 상대', '\\Windows\\a'],
    ['대체 데이터 스트림', 'C:\\Temp\\a.txt:hidden'],
    ['점으로 끝나는 이름', 'C:\\Windows.\\System32'],
    ['공백으로 끝나는 이름', 'C:\\Windows \\x'],
    ['금지 문자', 'C:\\Temp\\a*b']
  ])('거부: %s', (_name, raw) => {
    expect(sanitizeRawPath(raw).ok).toBe(false)
  })

  it('너무 긴 경로와 문자열이 아닌 값을 거부한다', () => {
    expect(sanitizeRawPath(`C:\\${'a'.repeat(MAX_PATH_LENGTH)}`).ok).toBe(false)
    expect(sanitizeRawPath(undefined).ok).toBe(false)
    expect(sanitizeRawPath(null).ok).toBe(false)
    expect(sanitizeRawPath(42).ok).toBe(false)
  })

  it('.. 와 슬래시 혼용을 해석한다', () => {
    expect(sanitizeRawPath('C:/Temp/a/../b//c')).toEqual({ ok: true, path: 'C:\\Temp\\b\\c' })
    expect(sanitizeRawPath('C:\\Temp\\..\\Windows')).toEqual({ ok: true, path: 'C:\\Windows' })
    expect(sanitizeRawPath('C:\\..\\..')).toEqual({ ok: true, path: 'C:\\' })
  })

  it('\\\\?\\ 접두사를 벗긴다', () => {
    expect(sanitizeRawPath('\\\\?\\C:\\Temp\\a')).toEqual({ ok: true, path: 'C:\\Temp\\a' })
  })
})

describe('삭제 관문 — 경로 거부', () => {
  it('허용: 규칙 범위 안의 일반 파일 (캐시 내용물)', async () => {
    const { check } = setup()
    const file = sb.write(`${CACHE}\\a.bin`)
    const verdict = await check(file)
    expect(verdict.allowed).toBe(true)
  })

  it.each([
    ['드라이브 루트', ''],
    ['Windows 자체', 'Windows'],
    ['Windows\\System32\\x.dll', 'Windows\\System32\\x.dll'],
    ['허용 예외가 아닌 Windows 하위(Prefetch)', 'Windows\\Prefetch\\a.pf'],
    ['Program Files', 'Program Files'],
    ['Program Files 하위', 'Program Files\\App\\app.exe'],
    ['Program Files (x86) 하위', 'Program Files (x86)\\App\\app.exe'],
    ['ProgramData 하위', 'ProgramData\\Microsoft\\x'],
    ['Users', 'Users'],
    ['사용자 폴더 루트', 'Users\\tester'],
    ['Documents', 'Users\\tester\\Documents'],
    ['Documents 하위', 'Users\\tester\\Documents\\report.docx'],
    ['Desktop 하위', 'Users\\tester\\Desktop\\a.txt'],
    ['Downloads 하위', 'Users\\tester\\Downloads\\a.zip'],
    ['OneDrive 하위', 'Users\\tester\\OneDrive\\a.txt'],
    ['.ssh 하위', 'Users\\tester\\.ssh\\id_rsa'],
    ['AppData 루트', 'Users\\tester\\AppData'],
    ['AppData\\Local 루트', 'Users\\tester\\AppData\\Local'],
    ['AppData\\Roaming 루트', 'Users\\tester\\AppData\\Roaming'],
    ['System Volume Information', 'System Volume Information\\x'],
    ['Recovery', 'Recovery\\x'],
    ['pagefile.sys', 'pagefile.sys'],
    ['ntuser.dat', 'Users\\tester\\ntuser.dat']
  ])('보호 경로 거부: %s', async (_name, rel) => {
    const { check } = setup()
    const path = rel === '' ? sb.root : sb.p(rel)
    const verdict = await check(path)
    expect(verdict).toMatchObject({ allowed: false, reason: 'protected-path' })
  })

  it('.. 우회: 허용 루트 안에서 시작해 Windows 로 빠져나가는 경로', async () => {
    const { check } = setup()
    const sneaky = `${sb.p(CACHE)}\\..\\..\\..\\..\\..\\..\\Windows\\System32\\x.dll`
    const verdict = await check(sneaky)
    expect(verdict).toMatchObject({ allowed: false, reason: 'protected-path' })
  })

  it('슬래시 혼용 / 대소문자 변형 / \\\\?\\ 접두사로도 보호 경로를 우회할 수 없다', async () => {
    const { check } = setup()
    const base = sb.p('Windows', 'System32', 'x.dll')
    for (const variant of [
      base.replace(/\\/g, '/'),
      base.toUpperCase(),
      base.toLowerCase(),
      `\\\\?\\${base}`,
      base.replace('Windows', 'WiNdOwS')
    ]) {
      const verdict = await check(variant)
      expect(verdict, variant).toMatchObject({ allowed: false, reason: 'protected-path' })
    }
  })

  it('8.3 짧은 이름: 입력은 평범해 보여도 실제 경로(realpath)가 보호 경로면 거부한다', async () => {
    // 짧은 이름 해석은 볼륨 설정에 따라 달라서 파일 시스템을 흉내 낸 FsReader 로 증명한다
    const fake: FsReader = {
      ...nodeFsReader,
      lstat: () =>
        Promise.resolve({
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: 1,
          mtimeMs: 0
        }),
      realpath: () => Promise.resolve(sb.p('Program Files', 'App', 'app.exe'))
    }
    const { check } = setup([rule()], { fs: fake })
    const verdict = await check(sb.p('PROGRA~1', 'App', 'app.exe'))
    expect(verdict).toMatchObject({ allowed: false, reason: 'protected-path' })
  })

  it('정션 우회: 허용 루트 안의 링크 자체는 거부(link)한다', async () => {
    const { check } = setup()
    sb.mkdir('Users\\tester\\Documents')
    if (!sb.link(`${CACHE}\\evil`, 'Users\\tester\\Documents')) return // 링크 생성 권한이 없는 환경
    expect(await check(sb.p(CACHE, 'evil'))).toMatchObject({ allowed: false, reason: 'link' })
  })

  it('정션 우회: 링크를 통과하는 파일 경로는 realpath 검사로 거부한다', async () => {
    const { check } = setup()
    sb.write('Users\\tester\\Documents\\secret.txt', 'secret')
    if (!sb.link(`${CACHE}\\evil`, 'Users\\tester\\Documents')) return
    const verdict = await check(sb.p(CACHE, 'evil', 'secret.txt'))
    expect(verdict).toMatchObject({ allowed: false, reason: 'protected-path' })
  })

  it('정션이 보호 구역이 아닌 규칙 없는 곳을 가리켜도 거부한다 (규칙 범위 밖)', async () => {
    const { check } = setup()
    sb.write('Elsewhere\\file.txt')
    if (!sb.link(`${CACHE}\\hop`, 'Elsewhere')) return
    const verdict = await check(sb.p(CACHE, 'hop', 'file.txt'))
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(['unknown-rule', 'outside-scope']).toContain(verdict.reason)
  })

  it('접두사 경계: 규칙 폴더 Cache 와 이름만 비슷한 Cache2 는 규칙 범위 밖이다', async () => {
    const { check } = setup()
    const file = sb.write('Users\\tester\\AppData\\Local\\TestApp\\Cache2\\x.bin')
    expect(await check(file)).toMatchObject({ allowed: false, reason: 'unknown-rule' })
    const sibling = sb.write('Users\\tester\\AppData\\Local\\TestApp\\CacheOld\\x.bin')
    expect(await check(sibling)).toMatchObject({ allowed: false, reason: 'unknown-rule' })
  })

  it('접두사 경계(보호 구역): Windows\\Temp2 는 Windows\\Temp 예외에 포함되지 않는다', async () => {
    const win = rule({
      id: 'win-temp',
      match: { kind: 'prefix', pattern: '%WINDIR%\\Temp' },
      category: 'temp',
      cleanup: {
        mode: 'contents',
        requiresAdmin: false,
        allowPermanent: true,
        group: 'W',
        defaultSelected: false
      }
    })
    const { check } = setup([win])
    const ok = sb.write('Windows\\Temp\\a.tmp')
    const bad = sb.write('Windows\\Temp2\\a.tmp')
    expect((await check(ok, 'trash', 'win-temp')).allowed).toBe(true)
    expect(await check(bad, 'trash', 'win-temp')).toMatchObject({
      allowed: false,
      reason: 'protected-path'
    })
  })

  it('규칙이 없는 곳(unknown)은 거부한다', async () => {
    const { check } = setup()
    const file = sb.write('Users\\tester\\AppData\\Local\\SomeApp\\data.bin')
    expect(await check(file)).toMatchObject({ allowed: false, reason: 'unknown-rule' })
  })

  it('protected 규칙이 가리키는 하위(더 구체적인 규칙)는 거부한다', async () => {
    const keep = rule({
      id: 'test-keep',
      match: { kind: 'prefix', pattern: `%LOCALAPPDATA%\\TestApp\\Cache\\Keep` },
      safety: 'protected',
      cleanable: false
    })
    const { check } = setup([rule(), withoutCleanup(keep)])
    const file = sb.write(`${CACHE}\\Keep\\important.db`)
    expect(await check(file)).toMatchObject({ allowed: false, reason: 'protected-rule' })
    const other = sb.write(`${CACHE}\\temp.bin`)
    expect((await check(other)).allowed).toBe(true)
  })

  it('다른 정리 항목의 영역은 이 항목으로 지울 수 없다 (outside-scope)', async () => {
    const other = rule({
      id: 'test-other',
      match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\TestApp\\Cache\\Other' }
    })
    const { check } = setup([rule(), other])
    const file = sb.write(`${CACHE}\\Other\\x.bin`)
    expect(await check(file, 'trash', 'test-cache')).toMatchObject({
      allowed: false,
      reason: 'outside-scope'
    })
    expect((await check(file, 'trash', 'test-other')).allowed).toBe(true)
  })

  it('contents 모드는 규칙 루트 폴더 자체를 지우지 않는다', async () => {
    const { check } = setup()
    sb.mkdir(CACHE)
    expect(await check(sb.p(CACHE))).toMatchObject({ allowed: false, reason: 'self-not-allowed' })
  })

  it('self 모드는 규칙 루트 폴더를 지울 수 있다', async () => {
    const selfRule = rule({
      id: 'test-self',
      cleanup: {
        mode: 'self',
        requiresAdmin: false,
        allowPermanent: false,
        group: 'T',
        defaultSelected: false
      }
    })
    const { check } = setup([selfRule])
    sb.mkdir(CACHE)
    expect((await check(sb.p(CACHE), 'trash', 'test-self')).allowed).toBe(true)
  })

  it('self 모드라도 규칙에 없는 폴더는 거부한다', async () => {
    const selfRule = rule({
      id: 'test-self',
      cleanup: {
        mode: 'self',
        requiresAdmin: false,
        allowPermanent: false,
        group: 'T',
        defaultSelected: false
      }
    })
    const { check } = setup([selfRule])
    sb.mkdir('Users\\tester\\AppData\\Local\\NotInRules')
    expect(
      await check(sb.p('Users\\tester\\AppData\\Local\\NotInRules'), 'trash', 'test-self')
    ).toMatchObject({
      allowed: false,
      reason: 'unknown-rule'
    })
  })

  it('입력 형식 오류: 빈 문자열 / 널 문자 / 너무 긴 경로 / 상대 경로', async () => {
    const { check } = setup()
    for (const bad of [
      '',
      `${sb.root}\\a\0.txt`,
      `${sb.root}\\${'a'.repeat(MAX_PATH_LENGTH)}`,
      'relative\\file'
    ]) {
      expect(await check(bad), bad.slice(0, 20)).toMatchObject({
        allowed: false,
        reason: 'invalid-path'
      })
    }
  })

  it('브라우저 로그인/쿠키 같은 보호 파일 이름은 캐시 폴더 안에서도 거부한다', async () => {
    const { check } = setup()
    for (const name of ['Login Data', 'Cookies', 'Bookmarks', 'Web Data', 'Preferences']) {
      const file = sb.write(`${CACHE}\\${name}`)
      expect(await check(file), name).toMatchObject({ allowed: false, reason: 'protected-path' })
    }
  })

  it('없는 대상은 거부가 아니라 not-found 로 알린다', async () => {
    const { check } = setup()
    expect(await check(sb.p(CACHE, 'missing.bin'))).toMatchObject({
      allowed: false,
      reason: 'not-found'
    })
  })
})

describe('삭제 관문 — 규칙 조건 (SAFETY.md §4)', () => {
  it('표시 전용 규칙(cleanable: false)은 caution 이어도 거부한다', async () => {
    const display = withoutCleanup(
      rule({ id: 'test-display', safety: 'caution', cleanable: false })
    )
    const { check } = setup([display])
    const file = sb.write(`${CACHE}\\a.bin`)
    expect(await check(file, 'trash', 'test-display')).toMatchObject({
      allowed: false,
      reason: 'not-cleanable'
    })
  })

  it('caution 은 경고 확인(acknowledgeCaution)이 있어야 허용된다', async () => {
    const caution = rule({ id: 'test-caution', safety: 'caution' })
    const { guard, loaded } = setup([caution])
    const file = sb.write(`${CACHE}\\a.bin`)
    const without = await guard.check({
      path: file,
      rule: loaded('test-caution'),
      mode: 'trash',
      permit: permitFor(['test-caution'], 'trash', false)
    })
    expect(without).toMatchObject({ allowed: false, reason: 'caution-not-acknowledged' })
    const withAck = await guard.check({
      path: file,
      rule: loaded('test-caution'),
      mode: 'trash',
      permit: permitFor(['test-caution'], 'trash', true)
    })
    expect(withAck.allowed).toBe(true)
  })

  it('protected/unknown 안전도의 규칙 객체는 어떤 경로도 지울 수 없다 (판정 함수)', () => {
    const base = setup().loaded()
    const make = (safety: string): LoadedRule => ({
      ...base,
      rule: { ...base.rule, safety } as LoadedRule['rule']
    })
    expect(judgeRule(make('protected'), 'trash', true, true)).toMatchObject({
      reason: 'protected-rule'
    })
    expect(judgeRule(make('unknown'), 'trash', true, true)).toMatchObject({
      reason: 'unknown-rule'
    })
  })

  it('영구 삭제: 규칙이 허용하지 않으면 거부', async () => {
    const noPermanent = rule({
      id: 'test-nope',
      cleanup: {
        mode: 'contents',
        requiresAdmin: false,
        allowPermanent: false,
        group: 'T',
        defaultSelected: false
      }
    })
    const { check } = setup([noPermanent])
    const file = sb.write(`${CACHE}\\a.bin`)
    expect(await check(file, 'permanent', 'test-nope')).toMatchObject({
      allowed: false,
      reason: 'permanent-not-allowed'
    })
    expect((await check(file, 'trash', 'test-nope')).allowed).toBe(true)
  })

  it('영구 삭제: 카테고리가 temp/cache 가 아니면 거부 (log/dump 는 휴지통만)', () => {
    const base = setup().loaded()
    const logRule: LoadedRule = { ...base, rule: { ...base.rule, category: 'log' } }
    expect(judgeRule(logRule, 'permanent', true, true)).toMatchObject({
      reason: 'permanent-not-allowed'
    })
    expect(judgeRule(logRule, 'trash', true, true)).toBeNull()
  })

  it('영구 삭제: 설정에서 꺼져 있으면 거부', async () => {
    const e = setup(
      [
        rule({
          cleanup: {
            mode: 'contents',
            requiresAdmin: false,
            allowPermanent: true,
            group: 'T',
            defaultSelected: false
          }
        })
      ],
      { allowPermanent: false }
    )
    const file = sb.write(`${CACHE}\\a.bin`)
    expect(await e.check(file, 'permanent')).toMatchObject({
      allowed: false,
      reason: 'permanent-disabled'
    })
    expect((await e.check(file, 'trash')).allowed).toBe(true)
  })

  it('전용 동작(휴지통 비우기 등) 항목은 파일 삭제로 처리하지 않는다', () => {
    const base = setup().loaded()
    const special: LoadedRule = {
      ...base,
      rule: {
        ...base.rule,
        cleanup: {
          ...(base.rule.cleanup as NonNullable<PathRule['cleanup']>),
          specialAction: 'empty-recycle-bin'
        }
      }
    }
    expect(judgeRule(special, 'trash', true, true)).toMatchObject({ reason: 'special-action-only' })
  })
})

describe('삭제 관문 — 확인 단계(permit)', () => {
  it('permit 이 없으면 거부', async () => {
    const { guard, loaded } = setup()
    const file = sb.write(`${CACHE}\\a.bin`)
    const verdict = await guard.check({
      path: file,
      rule: loaded(),
      mode: 'trash',
      permit: undefined
    })
    expect(verdict).toMatchObject({ allowed: false, reason: 'no-confirmation' })
  })

  it('permit 모양만 흉내 낸 객체는 거부', async () => {
    const { guard, loaded } = setup()
    const file = sb.write(`${CACHE}\\a.bin`)
    const forged = {
      planId: 'x',
      mode: 'trash',
      itemIds: new Set(['test-cache']),
      acknowledgeCaution: true
    }
    const verdict = await guard.check({
      path: file,
      rule: loaded(),
      mode: 'trash',
      permit: forged as unknown as ExecutionPermit
    })
    expect(verdict).toMatchObject({ allowed: false, reason: 'no-confirmation' })
    expect(isIssuedPermit(forged)).toBe(false)
  })

  it('다른 항목/다른 모드로 받은 permit 은 거부', async () => {
    const { guard, loaded } = setup()
    const file = sb.write(`${CACHE}\\a.bin`)
    const otherItem = await guard.check({
      path: file,
      rule: loaded(),
      mode: 'trash',
      permit: permitFor(['something-else'])
    })
    expect(otherItem).toMatchObject({ allowed: false, reason: 'no-confirmation' })
    const otherMode = await guard.check({
      path: file,
      rule: loaded(),
      mode: 'permanent',
      permit: permitFor(['test-cache'], 'trash')
    })
    expect(otherMode).toMatchObject({ allowed: false, reason: 'no-confirmation' })
  })

  it('ExecutionPermit 은 외부에서 new 로 만들 수 없다', () => {
    const construct = (): unknown =>
      new (ExecutionPermit as unknown as new (...a: unknown[]) => ExecutionPermit)(
        Symbol('fake'),
        'p',
        'trash',
        ['test-cache'],
        true
      )
    expect(construct).toThrow()
  })
})

describe('ConfirmationStore — 일회용·TTL·계획 바인딩', () => {
  const consumeArgs = (id: string, over: Record<string, unknown> = {}) => ({
    planId: 'plan-1',
    confirmationId: id,
    digest: 'digest-1',
    mode: 'trash' as const,
    itemIds: ['a'],
    needsCautionAck: false,
    acknowledgeCaution: false,
    ...over
  })

  it('정상: 소비하면 permit 이 나오고, 두 번째 사용은 거부된다', () => {
    const store = new ConfirmationStore()
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    const first = store.consume(consumeArgs(confirmationId))
    expect(first.ok && isIssuedPermit(first.permit)).toBe(true)
    expect(store.consume(consumeArgs(confirmationId))).toEqual({ ok: false, reason: 'used' })
  })

  it('알 수 없는 토큰 / 빈 토큰', () => {
    const store = new ConfirmationStore()
    store.issue({ planId: 'plan-1', digest: 'digest-1' })
    expect(store.consume(consumeArgs('nope'))).toEqual({ ok: false, reason: 'unknown' })
    expect(store.consume(consumeArgs(''))).toEqual({ ok: false, reason: 'unknown' })
  })

  it('만료된 토큰은 거부된다 (TTL)', () => {
    const clock = { t: 1_000 }
    const store = new ConfirmationStore({ ttlMs: 60_000, now: () => clock.t })
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    clock.t += 60_000
    expect(store.consume(consumeArgs(confirmationId))).toEqual({ ok: false, reason: 'expired' })
    clock.t -= 30_000 // 시계를 되돌려도 이미 만료로 소비된 토큰은 살아나지 않는다
    expect(store.consume(consumeArgs(confirmationId)).ok).toBe(false)
  })

  it('TTL 직전까지는 유효하다', () => {
    const clock = { t: 0 }
    const store = new ConfirmationStore({ ttlMs: 60_000, now: () => clock.t })
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    clock.t = 59_999
    expect(store.consume(consumeArgs(confirmationId)).ok).toBe(true)
  })

  it('다른 계획의 토큰은 거부되고, 올바른 계획에서는 여전히 쓸 수 있다', () => {
    const store = new ConfirmationStore()
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    expect(store.consume(consumeArgs(confirmationId, { planId: 'plan-2' }))).toEqual({
      ok: false,
      reason: 'plan-mismatch'
    })
    expect(store.consume(consumeArgs(confirmationId)).ok).toBe(true)
  })

  it('계획 내용이 발급 때와 달라지면 거부된다', () => {
    const store = new ConfirmationStore()
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    expect(store.consume(consumeArgs(confirmationId, { digest: 'digest-CHANGED' }))).toEqual({
      ok: false,
      reason: 'plan-changed'
    })
  })

  it('caution 항목이 있는데 경고 확인이 없으면 거부하되 토큰은 살려 둔다', () => {
    const store = new ConfirmationStore()
    const { confirmationId } = store.issue({ planId: 'plan-1', digest: 'digest-1' })
    const denied = store.consume(consumeArgs(confirmationId, { needsCautionAck: true }))
    expect(denied).toEqual({ ok: false, reason: 'caution-not-acknowledged' })
    const ok = store.consume(
      consumeArgs(confirmationId, { needsCautionAck: true, acknowledgeCaution: true })
    )
    expect(ok.ok).toBe(true)
  })

  it('토큰은 매번 다르고 추측하기 어렵다', () => {
    const store = new ConfirmationStore()
    const ids = new Set(
      Array.from({ length: 50 }, () => store.issue({ planId: 'p', digest: 'd' }).confirmationId)
    )
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/)
  })
})
