import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// ipc/scan.ts 는 electron 을 import 하므로 단위 테스트에서는 모킹한다.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

import { AppError, wrapHandler } from '../../src/main/ipc/errors.ts'
import {
  childrenSchema,
  describeSchema,
  findSchema,
  nodeSchema,
  noPayload,
  scanIdSchema,
  topSchema
} from '../../src/main/ipc/scan.ts'
import { programIdSchema, programsListSchema } from '../../src/main/ipc/programSchemas.ts'
import { runScan } from '../../src/main/scanner/core.ts'
import type { ScanEngine, ScanHandle } from '../../src/main/scanner/manager.ts'
import { ScanService } from '../../src/main/scanner/service.ts'
import type { ScanProgress, ScanResult, ScanSummary } from '../../src/shared/types.ts'
import { createFixtureTree } from '../fixtures/createFixtureTree.ts'

const tree = createFixtureTree('service-basic')
const cacheDir = join(tmpdir(), 'disklens-test-fixtures', 'v1', 'cache-service')

/** 결과를 테스트가 원하는 시점에 내보내는 가짜 엔진 */
function fakeEngine(): ScanEngine & {
  finish: (r: ScanResult) => void
  cancelled: () => boolean
} {
  let resolveResult: (r: ScanResult) => void = () => undefined
  let cancelled = false
  let n = 0
  return {
    start(): ScanHandle {
      cancelled = false
      const scanId = `fake-${++n}`
      return { scanId, result: new Promise((res) => (resolveResult = res)) }
    },
    cancel: () => {
      cancelled = true
    },
    onProgress: () => () => undefined,
    finish: (r) => resolveResult(r),
    cancelled: () => cancelled
  }
}

function makeService(engine: ScanEngine) {
  const events = {
    done: [] as ScanSummary[],
    errors: [] as string[],
    progress: [] as ScanProgress[]
  }
  const service = new ScanService({
    engine,
    cacheDir,
    root: tree.root,
    events: {
      onProgress: (p) => events.progress.push(p),
      onDone: (s) => events.done.push(s),
      onError: (m) => events.errors.push(m)
    }
  })
  return { service, events }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('ScanService', () => {
  it('스캔 완료 → 결과 보관·캐시 저장·완료 이벤트, 이후 조회 가능', async () => {
    const engine = fakeEngine()
    const { service, events } = makeService(engine)
    const { scanId } = service.start()
    engine.finish({ ...(await runScan(tree.root, { allocatedSize: false }, { scanId })) })
    await tick()
    expect(events.done).toHaveLength(1)
    expect(events.done[0]?.totalBytes).toBe(tree.totalLogical())
    const root = events.done[0]?.rootNodeId ?? ''
    const children = service.getChildren({
      scanId,
      nodeId: root,
      sort: 'size',
      limit: 50,
      offset: 0
    })
    expect(children.length).toBeGreaterThan(0)
    expect(service.getTypeSummary(scanId).length).toBeGreaterThan(0)
    expect(service.getSkipped(scanId).total).toBe(0)

    // 캐시: 새 서비스(=앱 재시작)가 같은 결과를 불러온다
    const restarted = makeService(fakeEngine()).service
    const cached = await restarted.loadCache()
    expect(cached?.scanId).toBe(scanId)
    expect(cached?.totalBytes).toBe(tree.totalLogical())
  })

  it('스캔 중에 다시 시작하면 BUSY, 다른 scanId 취소는 NOT_FOUND', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    const { scanId } = service.start()
    expect(() => service.start()).toThrowError(expect.objectContaining({ code: 'BUSY' }))
    expect(() => service.cancel('other')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    service.cancel(scanId)
    expect(engine.cancelled()).toBe(true)
    engine.finish(await runScan(tree.root, {}, { scanId }))
    await tick()
  })

  it('취소된 부분 결과는 채택하지 않고 이전 결과를 유지한다', async () => {
    const engine = fakeEngine()
    const { service, events } = makeService(engine)
    const first = service.start()
    engine.finish(await runScan(tree.root, { allocatedSize: false }, { scanId: first.scanId }))
    await tick()

    const second = service.start()
    const partial = await runScan(
      tree.root,
      {},
      { scanId: second.scanId, token: { cancelled: true } }
    )
    expect(partial.summary.cancelled).toBe(true)
    engine.finish(partial)
    await tick()

    expect(events.done.at(-1)?.cancelled).toBe(true)
    // 이전 결과는 그대로 조회 가능, 취소된 스캔 ID는 조회 불가
    const root = events.done[0]?.rootNodeId ?? ''
    expect(() =>
      service.getChildren({ scanId: first.scanId, nodeId: root, sort: 'size', limit: 5, offset: 0 })
    ).not.toThrow()
    expect(() =>
      service.getChildren({
        scanId: second.scanId,
        nodeId: root,
        sort: 'size',
        limit: 5,
        offset: 0
      })
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('스캔이 실패하면 오류 이벤트를 보내고 다시 시작할 수 있다', async () => {
    const engine = fakeEngine()
    const failing: ScanEngine = {
      ...engine,
      start: () => ({ scanId: 'bad', result: Promise.reject(new Error('boom')) })
    }
    const { service, events } = makeService(failing)
    service.start()
    await tick()
    expect(events.errors).toEqual(['boom'])
    expect(() => service.start()).not.toThrow() // BUSY 상태가 풀려 있다
  })

  it('경로 해석은 알려진 ID만 허용한다', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    const { scanId } = service.start()
    engine.finish(await runScan(tree.root, { allocatedSize: false }, { scanId }))
    await tick()
    expect(service.resolve(scanId, `own:0`)).toBe(tree.root)
    expect(() => service.resolve(scanId, 'C:\\Windows')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(() => service.resolve('wrong-scan', '0')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})

describe('wrapHandler (IPC 입력 검증 → 서비스 호출 → 결과 변환)', () => {
  const schema = z.object({ n: z.number() }).strict()

  it('검증 실패 시 서비스를 호출하지 않고 INVALID_REQUEST', async () => {
    const fn = vi.fn()
    const handler = wrapHandler(schema, fn)
    for (const bad of [undefined, null, 'x', {}, { n: '1' }, { n: 1, extra: true }]) {
      expect(await handler(bad)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('AppError는 코드를 유지하고, 그 밖의 오류는 내용을 숨기고 INTERNAL', async () => {
    const log = vi.fn()
    const denied = wrapHandler(schema, () => {
      throw new AppError('NOT_FOUND', '없음')
    })
    expect(await denied({ n: 1 })).toEqual({ ok: false, code: 'NOT_FOUND', message: '없음' })
    const crash = wrapHandler(
      schema,
      () => {
        throw new Error('C:\\secret\\path 내부 정보')
      },
      log
    )
    const r = await crash({ n: 1 })
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' })
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(log).toHaveBeenCalled()
  })

  it('정상이면 { ok: true, data }', async () => {
    expect(await wrapHandler(schema, (i) => i.n * 2)({ n: 4 })).toEqual({ ok: true, data: 8 })
  })
})

describe('IPC 스키마: 경로가 아니라 ID만 받는다', () => {
  it('경로나 알 수 없는 필드가 붙은 요청은 거부한다', () => {
    expect(nodeSchema.safeParse({ scanId: 's', nodeId: '1' }).success).toBe(true)
    expect(nodeSchema.safeParse({ scanId: 's', nodeId: '1', path: 'C:\\Windows' }).success).toBe(
      false
    )
    expect(nodeSchema.safeParse({ scanId: 's' }).success).toBe(false)
    expect(nodeSchema.safeParse({ scanId: '', nodeId: '1' }).success).toBe(false)
    expect(scanIdSchema.safeParse({ scanId: 's', path: 'x' }).success).toBe(false)
  })

  it('목록 요청의 limit/offset/sort 범위를 검증한다', () => {
    const ok = { scanId: 's', nodeId: '1', sort: 'size', limit: 100, offset: 0 }
    expect(childrenSchema.safeParse(ok).success).toBe(true)
    for (const patch of [
      { sort: 'path' },
      { limit: 0 },
      { limit: 999999 },
      { offset: -1 },
      { limit: 1.5 }
    ]) {
      expect(childrenSchema.safeParse({ ...ok, ...patch }).success, JSON.stringify(patch)).toBe(
        false
      )
    }
    expect(topSchema.safeParse({ scanId: 's', kind: 'files', limit: 500 }).success).toBe(true)
    expect(topSchema.safeParse({ scanId: 's', kind: 'files', limit: 501 }).success).toBe(false)
    expect(topSchema.safeParse({ scanId: 's', kind: 'all', limit: 5 }).success).toBe(false)
  })

  it('필터/설명 요청의 범위와 열거값을 검증한다', () => {
    const ok = { scanId: 's', safety: 'safe', cleanableOnly: true, query: 'chrome', limit: 100 }
    expect(findSchema.safeParse(ok).success).toBe(true)
    for (const patch of [
      { safety: 'all2' },
      { limit: 501 },
      { query: 'x'.repeat(101) },
      { cleanableOnly: 'yes' },
      { path: 'x' }
    ]) {
      expect(findSchema.safeParse({ ...ok, ...patch }).success, JSON.stringify(patch)).toBe(false)
    }
    expect(describeSchema.safeParse({ scanId: 's', nodeIds: ['1', 'col:2'] }).success).toBe(true)
    expect(describeSchema.safeParse({ scanId: 's', nodeIds: [] }).success).toBe(false)
    expect(describeSchema.safeParse({ scanId: 's', nodeIds: Array(201).fill('1') }).success).toBe(
      false
    )
    expect(describeSchema.safeParse({ scanId: 's', nodeIds: ['1'], paths: [] }).success).toBe(false)
  })

  it('프로그램 요청: 경로나 알 수 없는 필드를 받지 않는다 (programId 만)', () => {
    expect(programsListSchema.safeParse({ includeSystem: false, refresh: false }).success).toBe(
      true
    )
    for (const bad of [
      {},
      { includeSystem: 1, refresh: false },
      { includeSystem: true, refresh: false, path: 'C:\\x' }
    ]) {
      expect(programsListSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(programIdSchema.safeParse({ programId: 'App#abc123' }).success).toBe(true)
    expect(programIdSchema.safeParse({ programId: '' }).success).toBe(false)
    expect(
      programIdSchema.safeParse({ programId: 'x', installLocation: 'C:\\Windows' }).success
    ).toBe(false)
    expect(nodeSchema.safeParse({ scanId: 's', nodeId: '1' }).success).toBe(true)
  })

  it('스캔 시작/캐시 로드는 payload가 없어야 한다 (경로를 받지 않는다)', () => {
    expect(noPayload.safeParse(undefined).success).toBe(true)
    expect(noPayload.safeParse({}).success).toBe(true)
    expect(noPayload.safeParse({ root: 'C:\\Windows' }).success).toBe(false)
  })
})
