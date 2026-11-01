import { ipcMain } from 'electron'
import { IPC_CHANNELS, type PingResponse, type SecurityInfo } from '../../shared/ipc'

/** 입력 검증: ping 요청은 { message: string(1~200자) } 만 허용한다. */
export function parsePing(input: unknown): string {
  if (typeof input !== 'object' || input === null) throw new Error('INVALID_REQUEST')
  const message = (input as { message?: unknown }).message
  if (typeof message !== 'string' || message.length === 0 || message.length > 200) {
    throw new Error('INVALID_REQUEST')
  }
  return message
}

export function registerPingHandlers(getSecurity: () => SecurityInfo): void {
  ipcMain.handle(IPC_CHANNELS.ping, (_event, req: unknown): PingResponse => {
    return { ok: true, echo: parsePing(req), at: new Date().toISOString() }
  })
  ipcMain.handle(IPC_CHANNELS.securityInfo, () => getSecurity())
}
