// 정리 서비스 테스트 (TEST_PLAN.md §4.4 "허용되어야 하는 케이스"와 "실행 동작").
// 삭제는 모두 샌드박스(임시 폴더의 가짜 드라이브) 안의 파일에만 일어난다. 휴지통은 샌드박스 `.trash` 로 옮기는 모의 구현이다.
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeRemovePort, type RemovePort } from '../../src/main/cleaner/fsPort.ts'
import { createFileHistory } from '../../src/main/cleaner/history.ts'
import { createFileLogger } from '../../src/main/cleaner/log.ts'
import { AppError } from '../../src/main/ipc/errors.ts'
import type { PathRule } from '../../src/shared/rules.ts'
import { buildEngine, type EngineOptions } from '../fixtures/deleteEngine.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'
import { rule as baseRule } from '../fixtures/ruleHelpers.ts'

const CACHE = 'Users\\tester\\AppData\\Local\\TestApp\\Cache'
const cleanup = (
  over: Partial<NonNullable<PathRule['cleanup']>> = {}
): NonNullable<PathRule['cleanup']> => ({
  mode: 'contents',
  requiresAdmin: false,
  allowPermanent: true,
  group: '테스트',
  defaultSelected: false,
  ...over
})

/** 기본 규칙: 영구 삭제를 허용하는 캐시 규칙 (테스트마다 필요한 것만 바꾼다) */
const rule = (over: Partial<PathRule> = {}): PathRule => baseRule({ cleanup: cleanup(), ...over })

let sb: Sandbox
beforeEach(() => {
  sb = createSandbox()
})
afterEach(() => sb.dispose())

const engine = (rules: PathRule[] = [rule()], options: EngineOptions = {}) =>
  buildEngine(sb, rules, options)

async function denied(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('거부되어야 하는데 성공했습니다')
}

describe('plan — 미리보기는 아무것도 지우지 않는다', () => {
  it('대상 수/용량/대표 경로를 계산하고 확인 토큰을 발급한다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`, 'x'.repeat(100))
    sb.write(`${CACHE}\\sub\\b.bin`, 'x'.repeat(300))
    sb.write(`${CACHE}\\sub\\c.bin`, 'x'.repeat(200))
    const plan = await e.service.plan(['test-cache'], 'trash')
    expect(plan.totalFiles).toBe(3)
    expect(plan.totalBytes).toBe(600)
    expect(plan.items[0]?.sample[0]).toContain('b.bin') // 가장 큰 것부터
    expect(plan.confirmationId).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.needsCautionAck).toBe(false)
    expect(Date.parse(plan.expiresAt)).toBeGreaterThan(Date.now())
    // 아무것도 지워지지 않았다
    expect(existsSync(sb.p(CACHE, 'a.bin'))).toBe(true)
    expect(existsSync(sb.p(CACHE, 'sub', 'b.bin'))).toBe(true)
    expect(e.trash.calls).toEqual([])
  })

  it('규칙 폴더가 없으면 대상 0개', async () => {
    const plan = await engine().service.plan(['test-cache'], 'trash')
    expect(plan.totalFiles).toBe(0)
  })

  it('거부: 항목 없음 / 알 수 없는 항목 / 표시 전용·보호 항목', async () => {
    const protectedRule = rule({ id: 'test-protected', safety: 'protected', cleanable: false })
    delete (protectedRule as { cleanup?: unknown }).cleanup
    const e = engine([rule(), protectedRule])
    expect((await denied(e.service.plan([], 'trash'))).code).toBe('INVALID_REQUEST')
    expect((await denied(e.service.plan(['nope'], 'trash'))).code).toBe('NOT_FOUND')
    expect((await denied(e.service.plan(['test-protected'], 'trash'))).code).toBe('NOT_FOUND')
    expect(e.service.listItems().map((i) => i.itemId)).toEqual(['test-cache'])
  })

  it('거부: 규칙이 영구 삭제를 허용하지 않는데 permanent 요청', async () => {
    const e = engine([rule({ cleanup: cleanup({ allowPermanent: false }) })])
    expect((await denied(e.service.plan(['test-cache'], 'permanent'))).code).toBe('SAFETY_DENIED')
  })

  it('거부: 설정에서 영구 삭제가 꺼져 있음', async () => {
    const e = engine([rule()], { allowPermanent: false })
    expect((await denied(e.service.plan(['test-cache'], 'permanent'))).code).toBe('SAFETY_DENIED')
    await expect(e.service.plan(['test-cache'], 'trash')).resolves.toBeDefined()
  })

  it('caution 항목이 있으면 경고 확인이 필요하다고 알리고 caution 은 기본 선택되지 않는다', async () => {
    const e = engine([
      rule({ id: 'test-caution', safety: 'caution', cleanup: cleanup({ defaultSelected: false }) })
    ])
    sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-caution'], 'trash')
    expect(plan.needsCautionAck).toBe(true)
    expect(plan.items[0]?.warnings.join(' ')).toContain('다시 만들어집니다')
    expect(e.service.listItems()[0]?.defaultSelected).toBe(false)
  })
})

describe('execute — 허용되는 삭제', () => {
  it('영구 삭제: 내용물만 지우고 규칙 폴더는 남긴다 (비게 된 하위 폴더는 정리)', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`, 'x'.repeat(10))
    sb.write(`${CACHE}\\sub\\b.bin`, 'x'.repeat(20))
    sb.write(`${CACHE}\\sub\\deeper\\c.bin`, 'x'.repeat(30))
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result).toMatchObject({
      deletedFiles: 3,
      freedBytes: 60,
      skippedFiles: 0,
      cancelled: false,
      mode: 'permanent'
    })
    expect(existsSync(sb.p(CACHE))).toBe(true) // 폴더 자체는 유지
    expect(readdirSync(sb.p(CACHE))).toEqual([])
  })

  it('휴지통 모드(기본): trash API 에 파일 경로가 하나씩 전달되고 영구 삭제는 쓰이지 않는다', async () => {
    const permanentCalls: string[] = []
    const trashCalls: string[] = []
    const port: RemovePort = {
      deleteFile: (p) => (permanentCalls.push(p), Promise.resolve()),
      deleteEmptyDir: (p) => (permanentCalls.push(p), Promise.resolve()),
      moveToTrash: (p) => (trashCalls.push(p), Promise.resolve())
    }
    const e = engine([rule()], { port })
    sb.write(`${CACHE}\\a.bin`)
    sb.write(`${CACHE}\\b.bin`)
    const plan = await e.service.plan(['test-cache'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.deletedFiles).toBe(2)
    expect(permanentCalls).toEqual([])
    expect(trashCalls.map((p) => p.toLowerCase()).sort()).toEqual(
      [sb.p(CACHE, 'a.bin'), sb.p(CACHE, 'b.bin')].map((p) => p.toLowerCase()).sort()
    )
  })

  it('휴지통 모의 구현으로 실제로 옮겨 본다 (파일은 샌드박스 .trash 로 이동)', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'trash')
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(existsSync(sb.p(CACHE, 'a.bin'))).toBe(false)
    expect(readdirSync(sb.p('.trash')).length).toBe(1)
  })

  it('휴지통 이동이 실패해도 영구 삭제로 바뀌지 않는다', async () => {
    const e = engine()
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'trash')
    e.trash.fail.on = true
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.deletedFiles).toBe(0)
    expect(result.skippedFiles).toBe(1)
    expect(existsSync(file)).toBe(true) // 파일이 그대로 있다
  })

  it('includeGlobs / excludeGlobs 가 적용된다', async () => {
    const e = engine([
      rule({ cleanup: cleanup({ includeGlobs: ['*.log', '*.tmp'], excludeGlobs: ['keep*'] }) })
    ])
    sb.write(`${CACHE}\\a.log`)
    sb.write(`${CACHE}\\b.tmp`)
    sb.write(`${CACHE}\\keep.log`)
    sb.write(`${CACHE}\\data.db`)
    sb.write(`${CACHE}\\nested\\c.log`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    expect(plan.totalFiles).toBe(3)
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(readdirSync(sb.p(CACHE)).sort()).toEqual(['data.db', 'keep.log'])
  })

  it('minAgeDays: 오래된 파일만 지운다', async () => {
    const e = engine([rule({ cleanup: cleanup({ minAgeDays: 7 }) })])
    sb.write(`${CACHE}\\old.bin`, 'x', 30)
    sb.write(`${CACHE}\\edge.bin`, 'x', 8)
    sb.write(`${CACHE}\\new.bin`, 'x', 1)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(readdirSync(sb.p(CACHE))).toEqual(['new.bin'])
  })

  it('caution + 경고 확인 → 허용', async () => {
    const e = engine([rule({ id: 'test-caution', safety: 'caution' })])
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-caution'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: true
    })
    expect(result.deletedFiles).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it('glob 규칙: 와일드카드 폴더(브라우저 프로필 등)를 펼쳐 각각의 캐시만 지운다', async () => {
    const chrome = rule({
      id: 'test-browser',
      match: { kind: 'glob', pattern: '%LOCALAPPDATA%\\Browser\\User Data\\*\\Cache' }
    })
    const e = engine([chrome])
    sb.write('Users\\tester\\AppData\\Local\\Browser\\User Data\\Default\\Cache\\c1')
    sb.write('Users\\tester\\AppData\\Local\\Browser\\User Data\\Profile 1\\Cache\\c2')
    const cookies = sb.write('Users\\tester\\AppData\\Local\\Browser\\User Data\\Default\\Cookies')
    const plan = await e.service.plan(['test-browser'], 'permanent')
    expect(plan.totalFiles).toBe(2)
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(existsSync(cookies)).toBe(true) // 로그인/쿠키는 그대로
    expect(
      existsSync(sb.p('Users\\tester\\AppData\\Local\\Browser\\User Data\\Default\\Cache\\c1'))
    ).toBe(false)
  })

  it('seed 규칙 파일 + 샌드박스 env: 사용자 임시 폴더 정리 (오래된 파일만)', async () => {
    const file = JSON.parse(readFileSync('resources/cleanup-rules.json', 'utf8')) as {
      pathRules: PathRule[]
    }
    const e = engine(file.pathRules) // 로드 거부가 하나라도 있으면 buildEngine 이 던진다
    const winUserTemp = e.rules.find((r) => r.rule.id === 'win-user-temp')
    expect(winUserTemp?.rule.cleanup?.minAgeDays).toBe(1)
    const oldFile = sb.write('Users\\tester\\AppData\\Local\\Temp\\old.tmp', 'x', 5)
    const newFile = sb.write('Users\\tester\\AppData\\Local\\Temp\\new.tmp', 'x', 0)
    const plan = await e.service.plan(['win-user-temp'], 'permanent')
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
    expect(existsSync(sb.p('Users\\tester\\AppData\\Local\\Temp'))).toBe(true)
  })
})

describe('execute — 확인 토큰 없이는 아무것도 지우지 않는다', () => {
  async function planWithFile() {
    const e = engine()
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    return { e, file, plan }
  }

  it('토큰이 틀리면 거부 + 파일 유지 + 거부 기록', async () => {
    const { e, file, plan } = await planWithFile()
    const err = await denied(
      e.service.execute({
        planId: plan.planId,
        confirmationId: 'x'.repeat(64),
        acknowledgeCaution: true
      })
    )
    expect(err.code).toBe('SAFETY_DENIED')
    expect(existsSync(file)).toBe(true)
    expect(e.logger.entries.some((x) => x.op === 'confirm' && x.result === 'denied')).toBe(true)
  })

  it('빈 토큰 / 계획 ID 없음', async () => {
    const { e, file, plan } = await planWithFile()
    expect(
      (
        await denied(
          e.service.execute({ planId: plan.planId, confirmationId: '', acknowledgeCaution: false })
        )
      ).code
    ).toBe('SAFETY_DENIED')
    expect(
      (
        await denied(
          e.service.execute({
            planId: 'no-such-plan',
            confirmationId: plan.confirmationId,
            acknowledgeCaution: false
          })
        )
      ).code
    ).toBe('NOT_FOUND')
    expect(existsSync(file)).toBe(true)
  })

  it('이미 사용한 토큰은 다시 쓸 수 없다', async () => {
    const { e, plan } = await planWithFile()
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    sb.write(`${CACHE}\\again.bin`)
    const err = await denied(
      e.service.execute({
        planId: plan.planId,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(['SAFETY_DENIED', 'NOT_FOUND']).toContain(err.code)
    expect(existsSync(sb.p(CACHE, 'again.bin'))).toBe(true)
  })

  it('만료된 토큰은 거부된다', async () => {
    const clock = { t: Date.now() }
    const e = engine([rule()], { clock, ttlMs: 60_000 })
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    clock.t += 61_000
    const err = await denied(
      e.service.execute({
        planId: plan.planId,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.message).toContain('시간이 지났습니다')
    expect(existsSync(file)).toBe(true)
  })

  it('다른 계획의 토큰으로는 실행할 수 없다', async () => {
    const e = engine()
    const file = sb.write(`${CACHE}\\a.bin`)
    const planA = await e.service.plan(['test-cache'], 'permanent')
    const planB = await e.service.plan(['test-cache'], 'permanent')
    const err = await denied(
      e.service.execute({
        planId: planA.planId,
        confirmationId: planB.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.code).toBe('SAFETY_DENIED')
    expect(existsSync(file)).toBe(true)
    // 올바른 토큰으로는 여전히 실행된다
    await expect(
      e.service.execute({
        planId: planA.planId,
        confirmationId: planA.confirmationId,
        acknowledgeCaution: false
      })
    ).resolves.toMatchObject({ deletedFiles: 1 })
  })

  it('caution 계획은 경고 확인 없이는 실행되지 않는다', async () => {
    const e = engine([rule({ id: 'test-caution', safety: 'caution' })])
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-caution'], 'trash')
    const err = await denied(
      e.service.execute({
        planId: plan.planId,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.message).toContain('경고')
    expect(existsSync(file)).toBe(true)
    await expect(
      e.service.execute({
        planId: plan.planId,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: true
      })
    ).resolves.toMatchObject({ deletedFiles: 1 })
  })
})

describe('execute — 계획 이후 상태가 바뀐 경우(실행 직전 재검사)', () => {
  it('계획 뒤에 하위 폴더가 보호 폴더로 가는 정션으로 바뀌면 따라가지 않고 보호 폴더는 그대로다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\sub\\a.bin`)
    const doc = sb.write('Users\\tester\\Documents\\keep.docx', 'precious')
    const plan = await e.service.plan(['test-cache'], 'permanent')
    expect(plan.totalFiles).toBe(1)

    // 계획 이후: sub 폴더를 비우고 Documents 를 가리키는 정션으로 바꿔치기
    sb.remove(`${CACHE}\\sub`)
    try {
      symlinkSync(sb.p('Users\\tester\\Documents'), sb.p(CACHE, 'sub'), 'junction')
    } catch {
      return // 링크를 만들 수 없는 환경
    }
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(readFileSync(doc, 'utf8')).toBe('precious')
    expect(result.deletedFiles).toBe(0)
    expect(result.perItem[0]?.skipped.find((s) => s.reason === 'link')?.count).toBe(1)
  })

  it('계획 뒤에 규칙 루트 자체가 정션으로 바뀌어도 링크 너머를 지우지 않는다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`)
    const sys = sb.write('Windows\\System32\\important.dll', 'system')
    const plan = await e.service.plan(['test-cache'], 'permanent')
    sb.remove(CACHE)
    try {
      symlinkSync(sb.p('Windows', 'System32'), sb.p(CACHE), 'junction')
    } catch {
      return
    }
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(readFileSync(sys, 'utf8')).toBe('system')
    expect(result.deletedFiles).toBe(0)
  })

  it('정션이 섞인 캐시: 일반 파일은 지우고 링크는 건너뛴다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`)
    const doc = sb.write('Users\\tester\\Documents\\keep.docx', 'precious')
    try {
      symlinkSync(sb.p('Users\\tester\\Documents'), sb.p(CACHE, 'link'), 'junction')
    } catch {
      return
    }
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.deletedFiles).toBe(1)
    expect(readFileSync(doc, 'utf8')).toBe('precious')
  })
})

describe('execute — 건너뜀·취소·기록', () => {
  it('사용 중 파일(EBUSY)은 건너뛰고 나머지는 계속한다', async () => {
    const base = createNodeRemovePort(() => Promise.resolve())
    const port: RemovePort = {
      ...base,
      deleteFile: (p) =>
        p.endsWith('busy.bin')
          ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
          : base.deleteFile(p)
    }
    const e = engine([rule()], { port })
    sb.write(`${CACHE}\\busy.bin`)
    sb.write(`${CACHE}\\ok1.bin`)
    sb.write(`${CACHE}\\ok2.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.deletedFiles).toBe(2)
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'in-use', count: 1 }])
    expect(existsSync(sb.p(CACHE, 'busy.bin'))).toBe(true)
  })

  it('권한 오류(EPERM)는 permission-denied 로 집계한다', async () => {
    const base = createNodeRemovePort(() => Promise.resolve())
    const port: RemovePort = {
      ...base,
      deleteFile: () => Promise.reject(Object.assign(new Error('x'), { code: 'EPERM' }))
    }
    const e = engine([rule()], { port })
    sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'permission-denied', count: 1 }])
  })

  it('취소하면 중단하고, 이미 지운 것은 기록에 남는다', async () => {
    // 진행 이벤트(파일 25개마다)에서 취소한다
    const ref: { cancel: () => boolean } = { cancel: () => false }
    const e = engine([rule()], { onProgress: () => ref.cancel() })
    ref.cancel = () => e.service.cancel()
    for (let i = 0; i < 80; i++) sb.write(`${CACHE}\\f${String(i).padStart(3, '0')}.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    expect(plan.totalFiles).toBe(80)
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.cancelled).toBe(true)
    expect(result.deletedFiles).toBe(25)
    expect(readdirSync(sb.p(CACHE)).length).toBe(55)
    expect(e.history.records[0]?.freedBytes).toBe(25) // 이미 지운 만큼은 기록에 남는다
  })

  it('실행 중이 아닐 때 cancel 은 false', () => {
    expect(engine().service.cancel()).toBe(false)
  })

  it('이미 진행 중이면 BUSY', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const base = createNodeRemovePort(() => Promise.resolve())
    const port: RemovePort = {
      ...base,
      deleteFile: async (p) => {
        await gate
        await base.deleteFile(p)
      }
    }
    const e = engine([rule()], { port })
    sb.write(`${CACHE}\\a.bin`)
    const first = await e.service.plan(['test-cache'], 'permanent')
    const second = await e.service.plan(['test-cache'], 'permanent')
    const running = e.service.execute({
      planId: first.planId,
      confirmationId: first.confirmationId,
      acknowledgeCaution: false
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(
      (
        await denied(
          e.service.execute({
            planId: second.planId,
            confirmationId: second.confirmationId,
            acknowledgeCaution: false
          })
        )
      ).code
    ).toBe('BUSY')
    release()
    await expect(running).resolves.toMatchObject({ deletedFiles: 1 })
  })

  it('요구하는 관리자 권한 항목은 이 프로세스에서 지우지 않고 admin-declined 로 기록한다', async () => {
    const e = engine([rule({ cleanup: cleanup({ requiresAdmin: true }) })])
    const file = sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    expect(plan.requiresAdmin).toBe(true)
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'admin-declined', count: 1 }])
    expect(existsSync(file)).toBe(true)
  })

  it('전용 동작(휴지통 비우기)은 모의 포트만 호출하고 파일을 지우지 않는다', async () => {
    const calls: string[] = []
    const special = {
      emptyRecycleBin: () => {
        calls.push('empty')
        return Promise.resolve()
      },
      runDiskCleanup: () => {
        calls.push('disk')
        return Promise.resolve()
      }
    }
    const bin = rule({
      id: 'test-bin',
      match: { kind: 'prefix', pattern: '%SYSTEMDRIVE%\\$Recycle.Bin' },
      category: 'other',
      cleanup: cleanup({ allowPermanent: false, specialAction: 'empty-recycle-bin' })
    })
    const e = engine([bin], { special })
    const file = sb.write('$Recycle.Bin\\S-1-5\\item')
    const plan = await e.service.plan(['test-bin'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(calls).toEqual(['empty'])
    expect(result.deletedFiles).toBe(0)
    expect(existsSync(file)).toBe(true)
    // 전용 동작 포트가 없는 엔진(7단계 앱)은 이 항목을 분석·계획 단계에서 거부한다
    const e2 = engine([bin])
    expect((await denied(e2.service.plan(['test-bin'], 'trash'))).code).toBe('NOT_FOUND')
    expect((await denied(e2.service.analyze('test-bin'))).code).toBe('NOT_FOUND')
  })

  it('analyze: 삭제 없이 항목 하나의 대상 수/용량을 계산한다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`, 'x'.repeat(40))
    sb.write(`${CACHE}\\b.bin`, 'x'.repeat(60))
    const result = await e.service.analyze('test-cache')
    expect(result).toMatchObject({ itemId: 'test-cache', fileCount: 2, bytes: 100 })
    expect(readdirSync(sb.p(CACHE)).length).toBe(2)
    expect((await denied(e.service.analyze('nope'))).code).toBe('NOT_FOUND')
  })

  it('start: jobId 를 먼저 돌려주고 done 으로 결과를 준다. cancel(jobId) 는 해당 작업에만 듣는다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const { jobId, done } = await e.service.start({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(e.service.cancel('another-job')).toBe(false)
    const result = await done
    expect(result.jobId).toBe(jobId)
    expect(result.deletedFiles).toBe(1)
    expect(e.service.cancel(jobId)).toBe(false) // 끝난 뒤에는 취소할 것이 없다
  })

  it('로그(JSONL)에 성공·건너뜀·거부가 모두 남고, 정리 기록이 저장된다', async () => {
    const e = engine()
    sb.write(`${CACHE}\\a.bin`)
    sb.write(`${CACHE}\\Login Data`) // 보호 파일 이름 → 관문이 거부
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.deletedFiles).toBe(1)
    const byResult = e.logger.entries.map((x) => `${x.op}:${x.result}`)
    expect(byResult).toContain('delete:ok')
    expect(byResult).toContain('delete:denied') // 거부된 요청도 남는다 (SAFETY.md §10)
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'safety-denied', count: 1 }])
    expect(existsSync(sb.p(CACHE, 'Login Data'))).toBe(true)
    expect(byResult).toContain('job:start')
    expect(byResult).toContain('job:end')
    expect(e.history.records).toHaveLength(1)
    expect(e.history.records[0]).toMatchObject({
      jobId: result.jobId,
      mode: 'permanent',
      itemIds: ['test-cache']
    })
  })

  it('거부된 항목도 로그에 남는다 (보호 파일 이름은 계획에서 제외되고 실행에서도 거부)', async () => {
    const e = engine()
    sb.write(`${CACHE}\\Cookies`)
    // 계획은 안전 검사로 제외한다
    const plan = await e.service.plan(['test-cache'], 'permanent')
    expect(plan.totalFiles).toBe(0)
    expect(plan.items[0]?.warnings.join(' ')).toContain('제외')
  })

  it('로그를 쓸 수 없으면 더 지우지 않고 오류를 알린다', async () => {
    const failing = { write: () => Promise.reject(new Error('disk full')) }
    const e = engine([rule()], { logger: failing })
    for (let i = 0; i < 5; i++) sb.write(`${CACHE}\\f${i}.bin`)
    const plan = await e.service.plan(['test-cache'], 'permanent')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.error).toContain('로그')
    expect(result.cancelled).toBe(true)
    expect(result.deletedFiles).toBe(0)
    expect(readdirSync(sb.p(CACHE)).length).toBe(5)
  })

  it('파일 로거는 logs/cleanup-YYYY-MM-DD.log 에 JSON 한 줄씩 쓴다', async () => {
    const logDir = sb.p('app-data', 'logs')
    const logger = createFileLogger(logDir, () => new Date(2026, 10, 1, 12, 0, 0).getTime())
    await logger.write({
      op: 'delete',
      result: 'denied',
      reason: 'protected-path',
      path: 'C:\\Windows\\x'
    })
    await logger.write({ op: 'delete', result: 'ok', path: 'C:\\t\\a', bytes: 5 })
    const file = sb.p('app-data', 'logs', 'cleanup-2026-11-01.log')
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ op: 'delete', result: 'denied', reason: 'protected-path' })
    expect(typeof lines[0]?.t).toBe('string')
  })

  it('정리 기록 파일: 저장·재로드, 500개 제한, 깨진 파일은 빈 기록으로 취급', async () => {
    const path = sb.p('app-data', 'cleanup-history.json')
    const history = createFileHistory(path)
    expect(await history.list()).toEqual([])
    for (let i = 0; i < 502; i++) {
      await history.add({
        jobId: `j${i}`,
        at: '2026-11-01T00:00:00Z',
        mode: 'trash',
        freedBytes: i,
        itemIds: ['a']
      })
    }
    const list = await history.list()
    expect(list).toHaveLength(500)
    expect(list[0]?.jobId).toBe('j2')
    sb.write('app-data\\broken.json', '{not json')
    expect(await createFileHistory(sb.p('app-data', 'broken.json')).list()).toEqual([])
  }, 60_000)
})
