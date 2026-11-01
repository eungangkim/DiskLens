import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runScan } from '../../src/main/scanner/core.ts'
import type { CancelToken, ScanFs } from '../../src/main/scanner/core.ts'
import { realFs } from '../../src/main/scanner/core.ts'
import { createFixtureTree } from '../fixtures/createFixtureTree.ts'
import type { FolderNode, ScanResult } from '../../src/shared/types.ts'

const tree = createFixtureTree('scan-basic')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function byPath(result: ScanResult): Map<string, FolderNode> {
  return new Map(result.nodes.map((n) => [n.path, n]))
}
function nodeAt(result: ScanResult, rel: string): FolderNode | undefined {
  return byPath(result).get(rel ? join(tree.root, rel) : tree.root)
}

/** 접힘 없이 모든 폴더를 보존하는 옵션 (용량 정확성 검증용) */
const noCollapse = { collapseThresholdBytes: 0, allocatedSize: false, topFilesK: 5 }

describe('폴더 용량 집계', () => {
  it('루트 용량 = 모든 파일 크기의 합 (정확한 값)', async () => {
    const r = await runScan(tree.root, noCollapse, { scanId: 't' })
    expect(r.summary.totalBytes).toBe(tree.totalLogical())
    expect(r.summary.totalFiles).toBe(tree.files.length)
    expect(r.summary.cancelled).toBe(false)
  })

  it('폴더별 용량이 하위 파일 합과 같고, 직계 합(ownFilesSize)과 구분된다', async () => {
    const r = await runScan(tree.root, noCollapse, { scanId: 't' })
    const docs = nodeAt(r, 'docs')
    expect(docs?.size).toBe(3000)
    expect(docs?.ownFilesSize).toBe(3000)
    expect(docs?.ownFileCount).toBe(2)
    const deep = nodeAt(r, 'deep')
    expect(deep?.size).toBe(5000)
    expect(deep?.ownFilesSize).toBe(0) // 파일은 60단계 아래에 있다
    expect(deep?.fileCount).toBe(1)
    expect(nodeAt(r, 'many')?.size).toBe(2000 * 100)
    expect(nodeAt(r, 'empty')?.size).toBe(0)
  })

  it('모든 노드에서 size = 직계 파일 합 + 자식 합 + 접힌 합', async () => {
    const r = await runScan(
      tree.root,
      { allocatedSize: false, collapseThresholdBytes: 10_000 },
      { scanId: 't' }
    )
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    for (const n of r.nodes) {
      const childSum = n.childIds.reduce((s, id) => s + (byId.get(id)?.size ?? 0), 0)
      expect(n.size).toBe(n.ownFilesSize + childSum + (n.collapsed?.size ?? 0))
    }
  })

  it('디스크 점유 크기는 클러스터(4096) 단위로 올림한다', async () => {
    const r = await runScan(
      tree.root,
      { allocatedSize: true, clusterSize: 4096, collapseThresholdBytes: 0 },
      { scanId: 't' }
    )
    expect(r.summary.allocatedSize).toBe(true)
    expect(r.summary.totalBytes).toBe(tree.totalAllocated(4096))
    expect(nodeAt(r, 'docs')?.size).toBe(4096 + 4096) // 1000B, 2000B → 각각 1클러스터
  })
})

describe('링크/정션', () => {
  it('링크를 따라가지 않고, 순환 링크에서도 끝나며, 이중 집계가 없다', async (ctx) => {
    if (!tree.junctionsCreated) {
      ctx.skip() // 정션을 만들 수 없는 환경
      return
    }
    const r = await runScan(tree.root, noCollapse, { scanId: 't' })
    expect(r.summary.totalBytes).toBe(tree.totalLogical()) // 링크 때문에 늘어나지 않는다
    const link = nodeAt(r, tree.junctions[0] as string)
    expect(link?.isLink).toBe(true)
    expect(link?.size).toBe(0)
    expect(nodeAt(r, 'media')?.size).toBe(4 * 1024 * 1024)
  })
})

describe('오류 처리', () => {
  it('폴더를 열 수 없으면 건너뜀으로 집계하고 계속한다', async () => {
    const blocked = join(tree.root, 'docs')
    const fs: ScanFs = {
      ...realFs,
      opendir: async (p) => {
        if (p === blocked) throw Object.assign(new Error('denied'), { code: 'EPERM' })
        return realFs.opendir(p)
      }
    }
    const r = await runScan(tree.root, noCollapse, { scanId: 't', fs })
    expect(r.summary.skippedCount).toBe(1)
    expect(r.skippedSample).toEqual([{ path: blocked, reason: 'permission-denied' }])
    expect(nodeAt(r, 'docs')?.truncated).toBe(true)
    expect(nodeAt(r, '')?.skippedChildren).toBe(1)
    expect(r.summary.totalBytes).toBe(tree.totalLogical() - tree.logicalSizeUnder('docs'))
  })

  it('파일 stat 실패(EBUSY/ENOENT)도 건너뜀으로 집계한다', async () => {
    const fs: ScanFs = {
      ...realFs,
      lstat: async (p) => {
        if (p.endsWith('v1.mp4')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        if (p.endsWith('v2.mp4')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        return realFs.lstat(p)
      }
    }
    const r = await runScan(tree.root, noCollapse, { scanId: 't', fs })
    expect(r.summary.skippedCount).toBe(2)
    expect(r.skippedSample.map((s) => s.reason).sort()).toEqual(['busy', 'not-found'])
    expect(nodeAt(r, 'media')?.size).toBe(0)
  })

  it('존재하지 않는 루트는 오류로 거부한다', async () => {
    await expect(runScan(join(tree.root, 'nope'), {}, { scanId: 't' })).rejects.toThrow()
  })
})

describe('취소', () => {
  it('취소 후 1초 안에 부분 결과와 함께 끝난다', async () => {
    const slow: ScanFs = {
      ...realFs,
      opendir: async (p) => {
        await sleep(20)
        return realFs.opendir(p)
      }
    }
    const token: CancelToken = { cancelled: false }
    const promise = runScan(
      tree.root,
      { ...noCollapse, concurrency: 2 },
      { scanId: 't', fs: slow, token }
    )
    await sleep(150)
    const t = Date.now()
    token.cancelled = true
    const r = await promise
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r.summary.cancelled).toBe(true)
    expect(r.summary.totalBytes).toBeLessThan(tree.totalLogical())
    // 부분 결과도 합계가 일관되어야 한다
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    for (const n of r.nodes) {
      const childSum = n.childIds.reduce((s, id) => s + (byId.get(id)?.size ?? 0), 0)
      expect(n.size).toBe(n.ownFilesSize + childSum + (n.collapsed?.size ?? 0))
    }
  })
})

describe('작은 폴더 접기', () => {
  const threshold = 10_000

  it('접힌 합 + 표시된 합 = 부모 합이고, 작은 폴더는 자식 목록에서 빠진다', async () => {
    const r = await runScan(
      tree.root,
      { allocatedSize: false, collapseThresholdBytes: threshold },
      { scanId: 't' }
    )
    const root = nodeAt(r, '')
    expect(root?.size).toBe(tree.totalLogical())
    expect(nodeAt(r, 'docs')).toBeUndefined() // 3000B < 10000B → 접힘
    expect(nodeAt(r, 'deep')).toBeUndefined()
    expect(nodeAt(r, 'many')).toBeDefined() // 200000B → 유지
    expect(nodeAt(r, 'media')).toBeDefined()
    expect(root?.collapsed?.count).toBeGreaterThanOrEqual(2)
    // 접으면 노드 수가 크게 줄어든다 (깊이 60 체인과 빈 폴더 등이 사라짐)
    const full = await runScan(tree.root, noCollapse, { scanId: 't' })
    expect(r.nodes.length).toBeLessThan(full.nodes.length / 2)
  })

  it('규칙 대상 폴더(keepNames/keepPaths)는 작아도 접지 않는다', async () => {
    const r = await runScan(
      tree.root,
      {
        allocatedSize: false,
        collapseThresholdBytes: threshold,
        keepNames: ['node_modules', 'Library'],
        keepPaths: [join(tree.root, 'Temp'), join(tree.root, 'Cache')]
      },
      { scanId: 't' }
    )
    for (const rel of ['Temp', 'Cache', 'node_modules', 'Library']) {
      expect(nodeAt(r, rel), rel).toBeDefined()
    }
    expect(nodeAt(r, join('node_modules', 'pkg'))).toBeUndefined() // 규칙 폴더 안쪽은 일반 규칙대로 접힘
    expect(nodeAt(r, '')?.size).toBe(tree.totalLogical())
  })

  it('규칙 폴더가 깊이 있으면 그 상위 폴더도 함께 유지한다', async () => {
    const r = await runScan(
      tree.root,
      {
        allocatedSize: false,
        collapseThresholdBytes: threshold,
        keepPaths: [join(tree.root, 'docs')]
      },
      { scanId: 't' }
    )
    expect(nodeAt(r, 'docs')).toBeDefined()
  })
})

describe('Top-K 파일과 유형 요약', () => {
  it('정확한 상위 K개를 큰 순서대로 돌려준다', async () => {
    const r = await runScan(tree.root, noCollapse, { scanId: 't' })
    const expected = [...tree.files].sort((a, b) => b.size - a.size).slice(0, 5)
    expect(r.topFiles.map((f) => f.size)).toEqual(expected.map((f) => f.size))
    expect(r.topFiles[0]?.path).toBe(join(tree.root, 'media', 'v1.mp4'))
    expect(r.topFiles[0]?.ext).toBe('mp4')
  })

  it('유형별 집계 합 = 전체 파일 합', async () => {
    for (const allocatedSize of [false, true]) {
      const r = await runScan(tree.root, { allocatedSize }, { scanId: 't' })
      expect(r.typeSummary.reduce((s, t) => s + t.bytes, 0)).toBe(r.summary.totalBytes)
      expect(r.typeSummary.reduce((s, t) => s + t.fileCount, 0)).toBe(r.summary.totalFiles)
    }
    const r = await runScan(tree.root, { allocatedSize: false }, { scanId: 't' })
    expect(r.typeSummary.find((t) => t.type === 'video')?.bytes).toBe(4 * 1024 * 1024)
  })
})

describe('진행 이벤트', () => {
  it('지정한 간격을 지켜 호출된다 (파일마다 호출하지 않는다)', async () => {
    const slow: ScanFs = {
      ...realFs,
      opendir: async (p) => {
        await sleep(10)
        return realFs.opendir(p)
      }
    }
    const times: number[] = []
    const start = Date.now()
    await runScan(
      tree.root,
      { ...noCollapse, concurrency: 4 },
      {
        scanId: 't',
        fs: slow,
        progressIntervalMs: 100,
        onProgress: () => times.push(Date.now())
      }
    )
    const elapsed = Date.now() - start
    expect(times.length).toBeGreaterThanOrEqual(1)
    expect(times.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2)
    expect(times.length).toBeLessThan(50) // 파일 2000개 이상인데 이벤트는 훨씬 적다
  })
})
