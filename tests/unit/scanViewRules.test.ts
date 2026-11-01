import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRuleSet } from '../../src/main/rules/loader.ts'
import { runScan } from '../../src/main/scanner/core.ts'
import {
  ancestorIds,
  buildIndex,
  describeNodes,
  findNodeByPath,
  findNodes,
  getChildren,
  getTopFiles
} from '../../src/main/scanner/view.ts'
import type { PathRule } from '../../src/shared/rules.ts'
import { createFixtureTree } from '../fixtures/createFixtureTree.ts'
import { rule, TEST_ENV, withoutCleanup } from '../fixtures/ruleHelpers.ts'

const tree = createFixtureTree('view-rules')

async function setup() {
  const rules: PathRule[] = [
    // media 폴더: 안전 + 정리 가능
    rule({
      id: 'fx-media',
      name: '미디어(시험)',
      match: { kind: 'prefix', pattern: join(tree.root, 'media') }
    }),
    // many 폴더: 주의 + 표시 전용
    withoutCleanup(
      rule({
        id: 'fx-many',
        name: '파일 많은 폴더',
        cleanable: false,
        safety: 'caution',
        match: { kind: 'prefix', pattern: join(tree.root, 'many') }
      })
    ),
    // empty 폴더: 보호
    withoutCleanup(
      rule({
        id: 'fx-empty',
        name: '비어 있음',
        cleanable: false,
        safety: 'protected',
        match: { kind: 'exact', pattern: join(tree.root, 'empty') }
      })
    )
  ]
  const set = buildRuleSet(
    { builtin: { schemaVersion: 1, rulesVersion: 't', pathRules: rules } },
    { env: TEST_ENV }
  )
  expect(set.issues).toEqual([])
  const result = await runScan(
    tree.root,
    { allocatedSize: false, collapseThresholdBytes: 0, ...set.matcher.scanHints() },
    { scanId: 'r' }
  )
  return buildIndex(result, set.matcher)
}

describe('트리 뷰에 규칙 매칭이 붙는다', () => {
  it('하위 폴더 행에 설명·안전도가 채워지고 규칙 없는 폴더는 unknown', async () => {
    const index = await setup()
    const rootId = index.result.summary.rootNodeId
    const views = getChildren(index, rootId, 'size', 100, 0) ?? []
    const by = (name: string) => views.find((v) => v.name === name)
    expect(by('media')?.match).toMatchObject({
      ruleId: 'fx-media',
      safety: 'safe',
      cleanable: true
    })
    expect(by('many')?.match).toMatchObject({ safety: 'caution', cleanable: false })
    expect(by('empty')?.match.safety).toBe('protected')
    const others = views.filter((v) => !['media', 'many', 'empty'].includes(v.name))
    expect(others.length).toBeGreaterThan(0)
    for (const v of others) expect(v.match.safety).toBe('unknown')
    // 규칙이 있어도 이 단계에서는 삭제 불가 (삭제 관문은 6단계)
    for (const v of views) expect(v.match.canDelete).toBe(false)
  })

  it('큰 파일 목록에도 상속된 규칙이 붙는다', async () => {
    const index = await setup()
    const files = getTopFiles(index, 5)
    const video = files.find((f) => f.name === 'v1.mp4')
    expect(video?.match.ruleId).toBe('fx-media')
  })

  it('합성 행(직계 파일)은 부모 규칙이 상속되는 경우에만 설명을 물려받는다', async () => {
    const index = await setup()
    const media = (getChildren(index, index.result.summary.rootNodeId, 'size', 100, 0) ?? []).find(
      (v) => v.name === 'media'
    )
    const inner = getChildren(index, media?.id ?? '', 'size', 100, 0) ?? []
    const own = inner.find((v) => v.kind === 'collapsed')
    if (own) expect(own.match.ruleId).toBe('fx-media')
    // exact 규칙(empty)은 자기 자신에만 적용된다
    const emptyId = (
      getChildren(index, index.result.summary.rootNodeId, 'size', 100, 0) ?? []
    ).find((v) => v.name === 'empty')?.id
    expect(describeNodes(index, [`own:${emptyId}`])?.[0]?.ruleId).toBeNull()
  })
})

describe('필터 (scan:find)', () => {
  const base = { cleanableOnly: false, query: '', limit: 50 }

  it('안전도 필터는 그 안전도의 규칙 루트만 큰 순으로 돌려준다', async () => {
    const index = await setup()
    const safe = findNodes(index, { ...base, safety: 'safe' })
    expect(safe.map((v) => v.name)).toEqual(['media'])
    expect(findNodes(index, { ...base, safety: 'caution' }).map((v) => v.name)).toEqual(['many'])
    expect(findNodes(index, { ...base, safety: 'protected' }).map((v) => v.name)).toEqual(['empty'])
  })

  it('"지워도 되는 것만"은 safe + cleanable 규칙 루트만', async () => {
    const index = await setup()
    const only = findNodes(index, { ...base, safety: 'all', cleanableOnly: true })
    expect(only.map((v) => v.match.ruleId)).toEqual(['fx-media'])
    // 정렬은 큰 순
    const sizes = findNodes(index, { ...base, safety: 'all', cleanableOnly: false }).map(
      (v) => v.size
    )
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
  })

  it('unknown 필터는 규칙이 없는 폴더만, 이름 검색은 대소문자를 무시한다', async () => {
    const index = await setup()
    const unknown = findNodes(index, { ...base, safety: 'unknown' })
    expect(unknown.length).toBeGreaterThan(0)
    for (const v of unknown) expect(v.match.safety).toBe('unknown')
    expect(unknown.map((v) => v.name)).not.toContain('media')

    const search = findNodes(index, { ...base, safety: 'all', query: 'MEDIA' })
    expect(search.map((v) => v.name)).toContain('media')
    expect(findNodes(index, { ...base, safety: 'safe', query: 'zzz-none' })).toEqual([])
  })

  it('limit 를 지킨다', async () => {
    const index = await setup()
    expect(findNodes(index, { ...base, safety: 'all', limit: 2 })).toHaveLength(2)
  })
})

describe('rules:describe', () => {
  it('폴더/합성 행/큰 파일 ID 의 매칭을 돌려주고, 모르는 ID 가 있으면 null', async () => {
    const index = await setup()
    const rootId = index.result.summary.rootNodeId
    const media = (getChildren(index, rootId, 'size', 100, 0) ?? []).find((v) => v.name === 'media')
    const result = describeNodes(index, [media?.id ?? '', 'f:0'])
    expect(result?.[0]?.ruleId).toBe('fx-media')
    expect(describeNodes(index, ['nope'])).toBeNull()
    expect(describeNodes(index, ['C:\\Windows'])).toBeNull()
    expect(describeNodes(index, [media?.id ?? '', 'col:nope'])).toBeNull()
  })
})

describe('경로로 폴더 찾기 / 위치 펼치기 (프로그램 설치 폴더 연결)', () => {
  it('경로(대소문자·슬래시·끝 구분자 무시)로 스캔 노드를 찾고, 없는 경로는 null', async () => {
    const index = await setup()
    const media = join(tree.root, 'media')
    const node = findNodeByPath(index, media)
    expect(node?.name).toBe('media')
    expect(findNodeByPath(index, media.toUpperCase() + '\\')?.id).toBe(node?.id)
    expect(findNodeByPath(index, media.replace(/\\/g, '/'))?.id).toBe(node?.id)
    expect(findNodeByPath(index, join(tree.root, 'no-such-folder'))).toBeNull()
  })

  it('루트부터 해당 폴더까지의 ID 를 돌려주고, 합성 행 ID 는 부모 폴더로 본다', async () => {
    const index = await setup()
    const rootId = index.result.summary.rootNodeId
    const media = findNodeByPath(index, join(tree.root, 'media'))!
    expect(ancestorIds(index, media.id)).toEqual([rootId, media.id])
    expect(ancestorIds(index, rootId)).toEqual([rootId])
    expect(ancestorIds(index, `own:${media.id}`)).toEqual([rootId, media.id])
    expect(ancestorIds(index, 'nope')).toBeNull()
  })
})
