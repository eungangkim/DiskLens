import { describe, expect, it, vi } from 'vitest'

// ping.ts 는 electron 을 import 하므로 단위 테스트에서는 모킹한다.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { parsePing } from '../../src/main/ipc/ping'

describe('parsePing (IPC 입력 검증)', () => {
  it('정상 입력은 message를 돌려준다', () => {
    expect(parsePing({ message: 'hello' })).toBe('hello')
  })

  it.each([
    null,
    undefined,
    'x',
    1,
    {},
    { message: 1 },
    { message: '' },
    { message: 'a'.repeat(201) }
  ])('잘못된 입력은 INVALID_REQUEST 로 거부한다: %j', (input) => {
    expect(() => parsePing(input)).toThrow('INVALID_REQUEST')
  })
})
