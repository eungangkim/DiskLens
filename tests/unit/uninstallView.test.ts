import { describe, expect, it } from 'vitest'
import type { InstalledProgram } from '../../src/shared/types.ts'
import type { UninstallResult } from '../../src/shared/uninstall.ts'
import { resultTone, uninstallButtonState } from '../../src/renderer/src/lib/uninstallView.ts'

const prog = (over: Partial<InstalledProgram>): InstalledProgram =>
  ({ id: 'a#1', name: 'A', canUninstall: true, ...over }) as InstalledProgram

describe('uninstallButtonState', () => {
  it('제거 가능하면 활성, 진행 중이면 모두 비활성', () => {
    expect(uninstallButtonState(prog({}), false).disabled).toBe(false)
    expect(uninstallButtonState(prog({}), true).disabled).toBe(true)
  })
  it('protected 는 항상 비활성이고 사유를 보여 준다', () => {
    const s = uninstallButtonState(
      prog({ canUninstall: false, uninstallBlock: 'protected' }),
      false
    )
    expect(s.disabled).toBe(true)
    expect(s.title).toContain('제거 불가')
  })
  it('제거 명령이 없거나 안전하지 않으면 비활성', () => {
    for (const b of ['no-command', 'unsupported-command'] as const) {
      expect(
        uninstallButtonState(prog({ canUninstall: false, uninstallBlock: b }), false).disabled
      ).toBe(true)
    }
  })
})

describe('resultTone', () => {
  const r = (over: Partial<UninstallResult>): UninstallResult =>
    ({ status: 'finished', stillListed: false, ...over }) as UninstallResult
  it('상태별 색', () => {
    expect(resultTone(r({}))).toBe('ok')
    expect(resultTone(r({ stillListed: true }))).toBe('warn')
    expect(resultTone(r({ status: 'cancelled' }))).toBe('info')
    expect(resultTone(r({ status: 'declined' }))).toBe('info')
    expect(resultTone(r({ status: 'failed' }))).toBe('warn')
  })
})
