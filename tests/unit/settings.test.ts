// 설정 저장소 검증 (10단계): 스캔 루트·제외 폴더는 드라이브 절대경로만, 깨진 값은 기본값, 저장 전 main 이 다시 검증.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/ipc/errors.ts'
import {
  DEFAULT_SETTINGS,
  isPlainDrivePath,
  loadSettings,
  sanitizeSettings,
  validateSettings
} from '../../src/main/settings.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'

describe('isPlainDrivePath', () => {
  it('드라이브 절대경로만 통과', () => {
    expect(isPlainDrivePath('C:\\')).toBe(true)
    expect(isPlainDrivePath('D:\\Games\\Steam')).toBe(true)
    for (const bad of [
      'C:',
      'relative\\x',
      '\\\\server\\share',
      '\\\\?\\C:\\x',
      'C:\\a\\..\\b',
      'C:\\a\\.\\b',
      'C:\\a:stream',
      'C:\\a\\b ',
      'C:\\a\\b.',
      'C:\\a|b',
      'C:\\a*'
    ]) {
      expect(isPlainDrivePath(bad), bad).toBe(false)
    }
  })
})

describe('sanitizeSettings', () => {
  it('깨진 값은 그 항목만 기본값으로 돌린다', () => {
    expect(
      sanitizeSettings({
        allowPermanentDelete: 'yes',
        sizeUnit: 'TB',
        theme: 'purple',
        scanRoot: '\\\\evil\\share',
        excludePaths: ['C:\\ok', 5, '..\\x', 'C:\\ok']
      })
    ).toEqual({ ...DEFAULT_SETTINGS, excludePaths: ['C:\\ok'] })
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ allowPermanentDelete: true }).allowPermanentDelete).toBe(true)
  })
})

describe('validateSettings', () => {
  const exists = (p: string): boolean => p === 'C:\\Games'
  it('존재하지 않는 스캔 루트, 잘못된 제외 경로는 이유와 함께 거부', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, scanRoot: 'C:\\Games' }, exists)).toBeNull()
    expect(validateSettings({ ...DEFAULT_SETTINGS, scanRoot: 'C:\\Nope' }, exists)).toContain(
      '찾을 수 없'
    )
    expect(validateSettings({ ...DEFAULT_SETTINGS, scanRoot: '..\\x' }, exists)).toContain(
      '드라이브'
    )
    expect(validateSettings({ ...DEFAULT_SETTINGS, excludePaths: ['\\\\s\\x'] }, exists)).toContain(
      '올바르지'
    )
  })
})

describe('설정 저장소', () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = createSandbox()
  })
  afterEach(() => sb.dispose())

  it('저장하면 다시 읽히고, 검증에 실패하면 저장하지 않는다 (INVALID_REQUEST)', async () => {
    const path = sb.p('data', 'settings.json')
    const store = await loadSettings(path, { dirExists: (p) => p === 'C:\\Games' })
    const next = {
      ...DEFAULT_SETTINGS,
      sizeUnit: 'GB' as const,
      theme: 'dark' as const,
      scanRoot: 'C:\\Games',
      excludePaths: ['C:\\Games\\Cache']
    }
    expect(await store.set(next)).toEqual(next)
    expect((await loadSettings(path)).get()).toEqual(next)

    const err = await store.set({ ...next, scanRoot: 'C:\\Nope' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('INVALID_REQUEST')
    expect(JSON.parse(readFileSync(path, 'utf8')).scanRoot).toBe('C:\\Games') // 그대로
    expect(store.get().scanRoot).toBe('C:\\Games')
  })
  it('버전 1 파일(영구 삭제 하나)은 그 값을 이어받는다', async () => {
    sb.write('data/v1.json', JSON.stringify({ schemaVersion: 1, allowPermanentDelete: true }))
    const store = await loadSettings(sb.p('data', 'v1.json'))
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, allowPermanentDelete: true })
  })
})
