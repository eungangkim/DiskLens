import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runScan } from '../../src/main/scanner/core.ts'
import {
  buildIndex,
  getChildren,
  getTopFiles,
  getTopFolders,
  resolvePath
} from '../../src/main/scanner/view.ts'
import { createFixtureTree } from '../fixtures/createFixtureTree.ts'

const tree = createFixtureTree('view-basic')
const collapsed = { allocatedSize: false, collapseThresholdBytes: 10_000 }
const full = { allocatedSize: false, collapseThresholdBytes: 0 }

async function indexOf(options: Parameters<typeof runScan>[1]) {
  return buildIndex(await runScan(tree.root, options, { scanId: 'v' }))
}

describe('getChildren (폴더 트리 지연 로딩용 뷰)', () => {
  it('하위 폴더를 용량 내림차순으로 돌려주고, 비율 합이 1이다', async () => {
    const index = await indexOf(collapsed)
    const rootId = index.result.summary.rootNodeId
    const views = getChildren(index, rootId, 'size', 100, 0)
    expect(views).not.toBeNull()
    const sizes = (views ?? []).map((v) => v.size)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(tree.totalLogical())
    const pct = (views ?? []).reduce((s, v) => s + v.percentOfParent, 0)
    expect(pct).toBeCloseTo(1, 5)
  })

  it('접힌 작은 폴더와 직계 파일은 합성 행(col:/own:)으로 나온다', async () => {
    const index = await indexOf(collapsed)
    const rootId = index.result.summary.rootNodeId
    const views = getChildren(index, rootId, 'size', 100, 0) ?? []
    const col = views.find((v) => v.id === `col:${rootId}`)
    const own = views.find((v) => v.id === `own:${rootId}`)
    expect(col?.kind).toBe('collapsed')
    expect(col?.name).toContain('기타')
    expect(own?.kind).toBe('collapsed')
    expect(own?.hasChildren).toBe(false)
  })

  it('모든 항목은 아직 규칙이 없으므로 unknown이고 삭제할 수 없다(canDelete=false)', async () => {
    const index = await indexOf(full)
    const views = getChildren(index, index.result.summary.rootNodeId, 'size', 100, 0) ?? []
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) {
      expect(v.match.safety).toBe('unknown')
      expect(v.match.canDelete).toBe(false)
      expect(v.match.cleanable).toBe(false)
    }
  })

  it('정렬(이름/파일수), limit, offset을 지원한다', async () => {
    const index = await indexOf(full)
    const rootId = index.result.summary.rootNodeId
    const byName = getChildren(index, rootId, 'name', 100, 0) ?? []
    const names = byName.map((v) => v.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ko')))
    const byFiles = getChildren(index, rootId, 'files', 100, 0) ?? []
    expect(byFiles[0]?.name).toBe('many') // 파일 2000개
    const page = getChildren(index, rootId, 'size', 2, 1) ?? []
    const all = getChildren(index, rootId, 'size', 100, 0) ?? []
    expect(page.map((v) => v.id)).toEqual(all.slice(1, 3).map((v) => v.id))
  })

  it('하위가 있는 폴더만 hasChildren, 모르는 ID는 null', async () => {
    const index = await indexOf(full)
    const rootId = index.result.summary.rootNodeId
    const views = getChildren(index, rootId, 'size', 100, 0) ?? []
    expect(views.find((v) => v.name === 'many')?.hasChildren).toBe(true) // 직계 파일이 있음
    expect(views.find((v) => v.name === 'empty')?.hasChildren).toBe(false)
    expect(getChildren(index, 'nope', 'size', 10, 0)).toBeNull()
  })
})

describe('큰 폴더/파일 Top', () => {
  it('통과 폴더(용량 90% 이상이 하위 하나)는 빼고 가장 안쪽 큰 폴더를 보여준다', async () => {
    const index = await indexOf(full)
    const names = getTopFolders(index, 500).map((v) => v.name)
    expect(names).toContain('d59') // bottom.dat 5000B 을 직접 가진 가장 안쪽 폴더
    expect(names).not.toContain('d0') // d0 은 d1 하나에 100% → 통과 폴더
    expect(names).not.toContain(tree.root) // 루트는 제외
  })

  it('큰 파일 목록은 f:번호 ID를 가지고 전체 대비 비율을 계산한다', async () => {
    const index = await indexOf({ ...full, topFilesK: 5 })
    const files = getTopFiles(index, 3)
    expect(files.map((f) => f.id)).toEqual(['f:0', 'f:1', 'f:2'])
    expect(files[0]?.name).toBe('v1.mp4')
    expect(files[0]?.kind).toBe('file')
    expect(files[0]?.percentOfTotal).toBeCloseTo((3 * 1024 * 1024) / tree.totalLogical(), 6)
    expect(files[0]?.ext).toBe('mp4')
  })
})

describe('resolvePath (ID → 경로, renderer는 경로를 보내지 않는다)', () => {
  it('폴더/합성 행/큰 파일 ID를 경로로 해석한다', async () => {
    const index = await indexOf({ ...full, topFilesK: 5 })
    const rootId = index.result.summary.rootNodeId
    const media = (getChildren(index, rootId, 'size', 100, 0) ?? []).find((v) => v.name === 'media')
    expect(resolvePath(index, media?.id ?? '')).toBe(join(tree.root, 'media'))
    expect(resolvePath(index, `col:${rootId}`)).toBe(tree.root)
    expect(resolvePath(index, `own:${rootId}`)).toBe(tree.root)
    expect(resolvePath(index, 'f:0')).toBe(join(tree.root, 'media', 'v1.mp4'))
  })

  it('모르는 ID나 경로 문자열은 null (임의 경로 접근 불가)', async () => {
    const index = await indexOf(full)
    for (const bad of [
      'nope',
      'f:999',
      'f:-1',
      'f:abc',
      'col:nope',
      'C:\\Windows',
      '..\\..\\x',
      ''
    ]) {
      expect(resolvePath(index, bad), bad).toBeNull()
    }
  })
})
