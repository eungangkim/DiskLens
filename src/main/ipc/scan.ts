import { clipboard, ipcMain, shell } from 'electron'
import { statfs } from 'node:fs/promises'
import { z } from 'zod'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import type { DriveInfo } from '../../shared/types.ts'
import type { ScanService } from '../scanner/service.ts'
import { AppError, wrapHandler } from './errors.ts'

// --- 입력 스키마 (경로가 아니라 ID만 받는다) ---
const idString = z.string().min(1).max(64)
export const noPayload = z.undefined().or(z.null()).or(z.object({}).strict())
export const scanIdSchema = z.object({ scanId: idString }).strict()
export const childrenSchema = z
  .object({
    scanId: idString,
    nodeId: idString,
    sort: z.enum(['size', 'name', 'files']),
    limit: z.number().int().min(1).max(5000),
    offset: z.number().int().min(0)
  })
  .strict()
export const topSchema = z
  .object({
    scanId: idString,
    kind: z.enum(['folders', 'files']),
    limit: z.number().int().min(1).max(500)
  })
  .strict()
export const findSchema = z
  .object({
    scanId: idString,
    safety: z.enum(['all', 'safe', 'caution', 'protected', 'unknown']),
    cleanableOnly: z.boolean(),
    query: z.string().max(100),
    limit: z.number().int().min(1).max(500)
  })
  .strict()
export const describeSchema = z
  .object({ scanId: idString, nodeIds: z.array(idString).min(1).max(200) })
  .strict()
export const nodeSchema = z.object({ scanId: idString, nodeId: idString }).strict()

export function registerScanHandlers(
  service: ScanService,
  log: (message: string, error?: unknown) => void
): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC_CHANNELS.scanStart, (_e, raw: unknown) =>
    wrapHandler(noPayload, () => service.start(), log)(raw)
  )
  h(IPC_CHANNELS.scanCancel, (_e, raw: unknown) =>
    wrapHandler(scanIdSchema, (r) => (service.cancel(r.scanId), null), log)(raw)
  )
  h(IPC_CHANNELS.scanGetChildren, (_e, raw: unknown) =>
    wrapHandler(childrenSchema, (r) => service.getChildren(r), log)(raw)
  )
  h(IPC_CHANNELS.scanGetTop, (_e, raw: unknown) =>
    wrapHandler(topSchema, (r) => service.getTop(r), log)(raw)
  )
  h(IPC_CHANNELS.scanFind, (_e, raw: unknown) =>
    wrapHandler(findSchema, (r) => service.find(r), log)(raw)
  )
  h(IPC_CHANNELS.rulesDescribe, (_e, raw: unknown) =>
    wrapHandler(describeSchema, (r) => service.describe(r), log)(raw)
  )
  h(IPC_CHANNELS.scanGetAncestors, (_e, raw: unknown) =>
    wrapHandler(nodeSchema, (r) => service.getAncestors(r.scanId, r.nodeId), log)(raw)
  )
  h(IPC_CHANNELS.scanGetTypeSummary, (_e, raw: unknown) =>
    wrapHandler(scanIdSchema, (r) => service.getTypeSummary(r.scanId), log)(raw)
  )
  h(IPC_CHANNELS.scanGetSkipped, (_e, raw: unknown) =>
    wrapHandler(scanIdSchema, (r) => service.getSkipped(r.scanId), log)(raw)
  )
  h(IPC_CHANNELS.scanLoadCache, (_e, raw: unknown) =>
    wrapHandler(
      noPayload,
      async () => {
        const summary = await service.loadCache()
        return summary ? { summary } : null
      },
      log
    )(raw)
  )
  h(IPC_CHANNELS.getDriveInfo, (_e, raw: unknown) =>
    wrapHandler(
      noPayload,
      async (): Promise<DriveInfo> => {
        try {
          const s = await statfs(service.root)
          return {
            root: service.root,
            totalBytes: Number(s.blocks) * Number(s.bsize),
            freeBytes: Number(s.bavail) * Number(s.bsize)
          }
        } catch {
          throw new AppError('NOT_FOUND', '드라이브 정보를 읽을 수 없습니다.')
        }
      },
      log
    )(raw)
  )
  // 읽기 전용 동작만: 탐색기에서 보기, 경로를 클립보드에 복사. ID는 main이 경로로 해석한다.
  h(IPC_CHANNELS.showInExplorer, (_e, raw: unknown) =>
    wrapHandler(
      nodeSchema,
      (r) => (shell.showItemInFolder(service.resolve(r.scanId, r.nodeId)), null),
      log
    )(raw)
  )
  h(IPC_CHANNELS.copyPath, (_e, raw: unknown) =>
    wrapHandler(
      nodeSchema,
      (r) => (clipboard.writeText(service.resolve(r.scanId, r.nodeId)), null),
      log
    )(raw)
  )
}
