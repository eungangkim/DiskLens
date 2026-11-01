// 정리 화면 순수 로직, 설정 저장소, 가짜 드라이브 안전 조건, 정리 IPC 입력 검증 테스트 (7단계)
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CleanupItem, CleanupPlan } from '../../src/shared/cleanup.ts'
import {
  canConfirm,
  defaultSelection,
  groupItems,
  largestPaths,
  oneClickSelection,
  permanentAvailability,
  safeSelection,
  selectionTotals,
  summarizeSkips
} from '../../src/renderer/src/lib/cleanupView.ts'
import { resolveFakeDrive } from '../../src/main/devDrive.ts'
import {
  cleanupAnalyzeSchema,
  cleanupCancelSchema,
  cleanupExecuteSchema,
  cleanupPlanSchema,
  settingsSetSchema
} from '../../src/main/ipc/cleanupSchemas.ts'
import { DEFAULT_SETTINGS, loadSettings } from '../../src/main/settings.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'

const item = (over: Partial<CleanupItem> = {}): CleanupItem => ({
  itemId: 'a',
  name: 'A',
  group: 'Windows',
  description: 'd',
  impact: 'i',
  safety: 'safe',
  estimatedBytes: null,
  fileCount: null,
  requiresAdmin: false,
  allowPermanent: true,
  defaultSelected: true,
  ...over
})

describe('정리 화면 선택 규칙', () => {
  const items = [
    item({ itemId: 'safe-default' }),
    item({ itemId: 'safe-optional', defaultSelected: false }),
    item({ itemId: 'caution', safety: 'caution', defaultSelected: false }),
    item({ itemId: 'admin', requiresAdmin: true }),
    item({ itemId: 'special', specialAction: 'empty-recycle-bin', defaultSelected: false })
  ]

  it('처음 선택: safe + 규칙의 기본 선택만 (caution/전용 동작 제외)', () => {
    expect([...defaultSelection(items)].sort()).toEqual(['safe-default'])
  })

  it('[안전 항목만 선택]: safe 만, 관리자·전용 동작·caution 제외', () => {
    expect([...safeSelection(items)].sort()).toEqual(['safe-default', 'safe-optional'])
  })

  it('[원클릭 안전 정리]: safe + 기본 선택, caution 은 절대 포함하지 않는다', () => {
    expect(oneClickSelection(items)).toEqual(['safe-default'])
    const onlyCaution = [item({ itemId: 'c', safety: 'caution', defaultSelected: true })]
    expect(oneClickSelection(onlyCaution)).toEqual([])
  })

  it('그룹: 정해진 순서 → 나머지 가나다순, 항목은 이름순', () => {
    const groups = groupItems([
      item({ itemId: '1', group: '개발 도구', name: 'B' }),
      item({ itemId: '2', group: 'Windows', name: 'Z' }),
      item({ itemId: '3', group: 'Windows', name: 'A' }),
      item({ itemId: '4', group: '새 그룹', name: 'C' }),
      item({ itemId: '5', group: '브라우저', name: 'D' })
    ])
    expect(groups.map((g) => g.group)).toEqual(['Windows', '브라우저', '개발 도구', '새 그룹'])
    expect(groups[0]?.items.map((i) => i.itemId)).toEqual(['3', '2'])
  })

  it('선택 합계는 분석이 끝난 항목만 센다', () => {
    const t = selectionTotals(new Set(['a', 'b', 'c']), {
      a: { status: 'done', fileCount: 3, bytes: 30, sample: [], warnings: [] },
      b: { status: 'running', fileCount: 0, bytes: 0, sample: [], warnings: [] }
    })
    expect(t).toEqual({ fileCount: 3, bytes: 30, analyzed: 1 })
  })

  it('건너뜀 사유를 항목 전체에서 합산해 많은 순으로 보여 준다', () => {
    const s = summarizeSkips([
      { itemId: 'a', freedBytes: 0, deletedFiles: 0, skipped: [{ reason: 'in-use', count: 2 }] },
      {
        itemId: 'b',
        freedBytes: 0,
        deletedFiles: 0,
        skipped: [
          { reason: 'in-use', count: 1 },
          { reason: 'admin-declined', count: 5 }
        ]
      }
    ])
    expect(s.map((x) => [x.reason, x.count])).toEqual([
      ['admin-declined', 5],
      ['in-use', 3]
    ])
  })
})

describe('영구 삭제 선택 가능 여부 (UI_SPEC §4.3)', () => {
  const items = [
    item({ itemId: 'ok' }),
    item({ itemId: 'no', name: '로그', allowPermanent: false })
  ]
  it('설정이 꺼져 있으면 선택 불가', () => {
    expect(permanentAvailability(items, ['ok'], false)).toMatchObject({ ok: false })
  })
  it('설정이 켜져 있어도 허용하지 않는 항목이 섞이면 불가 (항목 이름을 알려 준다)', () => {
    const r = permanentAvailability(items, ['ok', 'no'], true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('로그')
  })
  it('설정 켜짐 + 모두 허용 항목이면 가능', () => {
    expect(permanentAvailability(items, ['ok'], true)).toEqual({ ok: true })
  })
})

describe('확인 대화상자 실행 조건', () => {
  const plan = (over: Partial<CleanupPlan> = {}): CleanupPlan => ({
    planId: 'p',
    mode: 'trash',
    items: [
      { itemId: 'a', fileCount: 2, bytes: 100, sample: ['C:\\x\\big', 'C:\\x\\mid'], warnings: [] },
      { itemId: 'b', fileCount: 1, bytes: 900, sample: ['C:\\y\\huge'], warnings: [] }
    ],
    totalFiles: 3,
    totalBytes: 1000,
    requiresAdmin: false,
    needsCautionAck: false,
    confirmationId: 't',
    expiresAt: '2026-01-01T00:00:00Z',
    ...over
  })
  const base = { permanent: false, cautionAck: false, permanentAck: false }

  it('일반 계획은 체크 없이 실행 가능', () => {
    expect(canConfirm({ plan: plan(), ...base })).toBe(true)
  })
  it('caution 이 있으면 경고 확인 전에는 불가', () => {
    expect(canConfirm({ plan: plan({ needsCautionAck: true }), ...base })).toBe(false)
    expect(canConfirm({ plan: plan({ needsCautionAck: true }), ...base, cautionAck: true })).toBe(
      true
    )
  })
  it('영구 삭제는 "되돌릴 수 없음" 확인 전에는 불가', () => {
    expect(canConfirm({ plan: plan({ mode: 'permanent' }), ...base, permanent: true })).toBe(false)
    expect(
      canConfirm({
        plan: plan({ mode: 'permanent' }),
        ...base,
        permanent: true,
        permanentAck: true
      })
    ).toBe(true)
  })
  it('지울 파일이 없으면 불가', () => {
    expect(canConfirm({ plan: plan({ totalFiles: 0 }), ...base })).toBe(false)
  })
  it('가장 큰 대상 3개: 용량 큰 항목의 대표 경로부터', () => {
    expect(largestPaths(plan())).toEqual(['C:\\y\\huge', 'C:\\x\\big', 'C:\\x\\mid'])
    expect(largestPaths(plan(), 2)).toHaveLength(2)
  })
})

describe('정리 IPC 입력 검증 (strict)', () => {
  it('analyze/plan/execute/cancel 은 알 수 없는 필드와 경로 필드를 거부한다', () => {
    expect(cleanupAnalyzeSchema.safeParse({ itemId: 'a' }).success).toBe(true)
    expect(cleanupAnalyzeSchema.safeParse({ itemId: 'a', path: 'C:\\Windows' }).success).toBe(false)
    expect(cleanupPlanSchema.safeParse({ itemIds: ['a'], mode: 'trash' }).success).toBe(true)
    expect(
      cleanupPlanSchema.safeParse({ itemIds: ['a'], mode: 'trash', paths: ['C:\\'] }).success
    ).toBe(false)
    expect(cleanupPlanSchema.safeParse({ itemIds: [], mode: 'trash' }).success).toBe(false)
    expect(cleanupPlanSchema.safeParse({ itemIds: ['a'], mode: 'force' }).success).toBe(false)
    expect(
      cleanupExecuteSchema.safeParse({ planId: 'p', confirmationId: 't', acknowledgeCaution: true })
        .success
    ).toBe(true)
    expect(cleanupExecuteSchema.safeParse({ planId: 'p', acknowledgeCaution: true }).success).toBe(
      false
    )
    expect(
      cleanupExecuteSchema.safeParse({ planId: 'p', confirmationId: '', acknowledgeCaution: true })
        .success
    ).toBe(false)
    expect(cleanupCancelSchema.safeParse({ jobId: 'j' }).success).toBe(true)
    expect(cleanupCancelSchema.safeParse({}).success).toBe(false)
  })

  it('설정 저장은 허용된 필드만 받는다', () => {
    const ok = {
      allowPermanentDelete: true,
      sizeUnit: 'GB',
      theme: 'dark',
      scanRoot: null,
      excludePaths: []
    }
    expect(settingsSetSchema.safeParse(ok).success).toBe(true)
    expect(settingsSetSchema.safeParse({ ...ok, allowPermanentDelete: 'yes' }).success).toBe(false)
    expect(settingsSetSchema.safeParse({ ...ok, command: 'x' }).success).toBe(false)
    expect(settingsSetSchema.safeParse({ ...ok, theme: 'red' }).success).toBe(false)
    expect(settingsSetSchema.safeParse({ allowPermanentDelete: true }).success).toBe(false)
  })
})

describe('설정 저장소', () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = createSandbox()
  })
  afterEach(() => sb.dispose())

  it('파일이 없으면 영구 삭제는 꺼짐(기본)이고, 저장하면 다시 읽힌다', async () => {
    const path = sb.p('data', 'settings.json')
    const store = await loadSettings(path)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    await store.set({ ...DEFAULT_SETTINGS, allowPermanentDelete: true })
    expect((await loadSettings(path)).get()).toEqual({
      ...DEFAULT_SETTINGS,
      allowPermanentDelete: true
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 2 })
  })

  it('깨진 파일/다른 버전은 안전한 기본값으로 시작한다', async () => {
    sb.write('data\\broken.json', '{nope')
    expect((await loadSettings(sb.p('data', 'broken.json'))).get().allowPermanentDelete).toBe(false)
    sb.write('data\\v9.json', JSON.stringify({ schemaVersion: 9, allowPermanentDelete: true }))
    expect((await loadSettings(sb.p('data', 'v9.json'))).get().allowPermanentDelete).toBe(false)
  })
})

describe('가짜 드라이브(DISKLENS_FAKE_DRIVE) 안전 조건', () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = createSandbox()
  })
  afterEach(() => sb.dispose())

  it('임시 폴더 아래 disklens- 폴더만 허용하고, env 와 휴지통 폴더가 그 안을 가리킨다', () => {
    const drive = resolveFakeDrive({ value: sb.root, isPackaged: false, tmpDir: tmpdir() })
    const root = drive?.root.toLowerCase() ?? '?'
    expect(root).toBe(sb.root.toLowerCase())
    for (const value of Object.values(drive?.env ?? {}))
      expect(value.toLowerCase().startsWith(root)).toBe(true)
    expect(drive?.trashDir.toLowerCase().startsWith(root)).toBe(true)
  })

  it('값이 없거나 패키징된 앱이면 무시(null)', () => {
    expect(resolveFakeDrive({ value: undefined, isPackaged: false, tmpDir: tmpdir() })).toBeNull()
    expect(resolveFakeDrive({ value: '', isPackaged: false, tmpDir: tmpdir() })).toBeNull()
    expect(resolveFakeDrive({ value: sb.root, isPackaged: true, tmpDir: tmpdir() })).toBeNull()
  })

  it('임시 폴더 밖(C:\\Windows 등)이나 임시 폴더 자체는 예외로 거부한다', () => {
    expect(() =>
      resolveFakeDrive({ value: 'C:\\Windows', isPackaged: false, tmpDir: tmpdir() })
    ).toThrow(/DISKLENS_FAKE_DRIVE/)
    expect(() => resolveFakeDrive({ value: 'C:\\', isPackaged: false, tmpDir: tmpdir() })).toThrow()
    expect(() =>
      resolveFakeDrive({ value: tmpdir(), isPackaged: false, tmpDir: tmpdir() })
    ).toThrow()
  })
})
