import { ipcMain } from 'electron'
import type { CleanupResult } from '../../shared/cleanup.ts'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import type { CleanupHistory } from '../cleaner/history.ts'
import type { CleanupService } from '../cleaner/service.ts'
import type { SettingsStore } from '../settings.ts'
import {
  cleanupAnalyzeSchema,
  cleanupCancelSchema,
  cleanupExecuteSchema,
  cleanupPlanSchema,
  noArgsSchema as noArgs,
  settingsSetSchema
} from './cleanupSchemas.ts'
import { wrapHandler } from './errors.ts'

/**
 * 정리 IPC (ARCHITECTURE.md §6). renderer 는 경로가 아니라 항목 ID 와 확인 토큰만 보낸다.
 * 모든 삭제는 CleanupService → Remover.deleteTarget(safety 관문)을 거친다. 여기서는 판정하지 않는다.
 */
export function registerCleanupHandlers(
  service: CleanupService,
  history: CleanupHistory,
  settings: SettingsStore,
  onDone: (result: CleanupResult) => void,
  log: (message: string, error?: unknown) => void
): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC_CHANNELS.cleanupItems, (_e, raw: unknown) =>
    wrapHandler(noArgs, () => service.listItems(), log)(raw)
  )
  h(IPC_CHANNELS.cleanupAnalyze, (_e, raw: unknown) =>
    wrapHandler(cleanupAnalyzeSchema, (r) => service.analyze(r.itemId), log)(raw)
  )
  h(IPC_CHANNELS.cleanupPlan, (_e, raw: unknown) =>
    wrapHandler(cleanupPlanSchema, (r) => service.plan(r.itemIds, r.mode), log)(raw)
  )
  h(IPC_CHANNELS.cleanupExecute, (_e, raw: unknown) =>
    wrapHandler(
      cleanupExecuteSchema,
      async (r) => {
        const { jobId, done } = await service.start(r)
        done.then(onDone).catch((error: unknown) => log('정리 작업이 비정상 종료되었습니다', error))
        return { jobId }
      },
      log
    )(raw)
  )
  h(IPC_CHANNELS.cleanupCancel, (_e, raw: unknown) =>
    wrapHandler(cleanupCancelSchema, (r) => ({ cancelled: service.cancel(r.jobId) }), log)(raw)
  )
  h(IPC_CHANNELS.cleanupHistory, (_e, raw: unknown) =>
    wrapHandler(noArgs, async () => (await history.list()).reverse(), log)(raw)
  )
  h(IPC_CHANNELS.settingsGet, (_e, raw: unknown) =>
    wrapHandler(noArgs, () => settings.get(), log)(raw)
  )
  h(IPC_CHANNELS.settingsSet, (_e, raw: unknown) =>
    wrapHandler(settingsSetSchema, (r) => settings.set(r), log)(raw)
  )
}
