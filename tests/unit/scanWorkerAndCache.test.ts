import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ScanManager } from '../../src/main/scanner/manager.ts'
import { loadLatestScanCache, saveScanCache } from '../../src/main/scanner/cache.ts'
import { runScan } from '../../src/main/scanner/core.ts'
import { createFixtureTree } from '../fixtures/createFixtureTree.ts'

const tree = createFixtureTree('scan-worker')
const workerUrl = new URL('../../src/main/scanner/scan.worker.ts', import.meta.url)

describe('ScanManager (worker_threads)', () => {
  it('worker에서 스캔하여 core와 같은 결과를 돌려주고 진행 이벤트를 전달한다', async () => {
    const manager = new ScanManager(workerUrl, 50)
    const progress: number[] = []
    manager.onProgress((p) => progress.push(p.filesScanned))
    const handle = manager.start(tree.root, { allocatedSize: false })
    const viaWorker = await handle.result
    const direct = await runScan(tree.root, { allocatedSize: false }, { scanId: 'x' })
    expect(viaWorker.summary.scanId).toBe(handle.scanId)
    expect(viaWorker.summary.totalBytes).toBe(direct.summary.totalBytes)
    expect(viaWorker.summary.totalBytes).toBe(tree.totalLogical())
    expect(viaWorker.nodes.length).toBe(direct.nodes.length)
    expect(progress.length).toBeGreaterThanOrEqual(1)
  })

  it('이미 실행 중이면 새 스캔을 거부하고, 취소 메시지를 보낼 수 있다', async () => {
    const manager = new ScanManager(workerUrl)
    const handle = manager.start(tree.root, { allocatedSize: false })
    expect(() => manager.start(tree.root)).toThrow('SCAN_ALREADY_RUNNING')
    manager.cancel()
    const r = await handle.result // 취소가 먼저 도착하든 스캔이 먼저 끝나든 결과는 항상 일관되어야 한다
    expect(typeof r.summary.cancelled).toBe('boolean')
    expect(r.nodes.length).toBeGreaterThan(0)
  })

  it('존재하지 않는 루트는 오류로 전달된다', async () => {
    const manager = new ScanManager(workerUrl)
    await expect(manager.start(join(tree.root, 'nope')).result).rejects.toThrow()
  })
})

describe('스캔 결과 캐시', () => {
  const cacheDir = join(tmpdir(), 'disklens-test-fixtures', 'v1', 'cache-roundtrip')

  it('저장 → 불러오기 결과가 완전히 같다', async () => {
    const result = await runScan(tree.root, { allocatedSize: false }, { scanId: 'cache-1' })
    await saveScanCache(cacheDir, result)
    const loaded = await loadLatestScanCache(cacheDir)
    expect(loaded).toEqual(JSON.parse(JSON.stringify(result)))
  })

  it('여러 번 저장해도 슬롯 3개만 쓰고, 가장 최근 것을 불러온다', async () => {
    let last = ''
    for (let i = 0; i < 5; i++) {
      const result = await runScan(
        tree.root,
        { allocatedSize: false },
        { scanId: `cache-seq-${i}` }
      )
      await saveScanCache(cacheDir, result)
      last = result.summary.scanId
      await new Promise((r) => setTimeout(r, 15)) // 파일 수정 시각이 겹치지 않게
    }
    const files = (await readdir(cacheDir)).filter((n) => n.endsWith('.json.gz'))
    expect(files.length).toBeLessThanOrEqual(3)
    expect((await loadLatestScanCache(cacheDir))?.summary.scanId).toBe(last)
  })

  it('캐시 폴더가 없거나 비어 있으면 null', async () => {
    expect(
      await loadLatestScanCache(join(tmpdir(), 'disklens-test-fixtures', 'v1', 'no-such-cache'))
    ).toBeNull()
  })
})
