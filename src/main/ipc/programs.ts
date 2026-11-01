import { ipcMain, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import type { UninstallResult } from '../../shared/uninstall.ts'
import type { ProgramService } from '../programs/service.ts'
import type { UninstallService } from '../programs/uninstall.ts'
import { AppError, wrapHandler } from './errors.ts'
import { programIdSchema, programsListSchema, uninstallSchema } from './programSchemas.ts'

export function registerProgramHandlers(
  service: ProgramService,
  uninstall: UninstallService,
  onUninstallDone: (result: UninstallResult) => void,
  log: (message: string, error?: unknown) => void
): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC_CHANNELS.programsList, (_e, raw: unknown) =>
    wrapHandler(programsListSchema, (r) => service.list(r.includeSystem, r.refresh), log)(raw)
  )

  // 제거: 미리보기(확인 토큰) → 실행. renderer 는 programId 만 보내고, 제거 명령은 main 이 레지스트리에서 다시 읽는다
  h(IPC_CHANNELS.programsUninstallPlan, (_e, raw: unknown) =>
    wrapHandler(programIdSchema, (r) => uninstall.plan(r.programId), log)(raw)
  )
  h(IPC_CHANNELS.programsUninstall, (_e, raw: unknown) =>
    wrapHandler(
      uninstallSchema,
      async (r) => {
        const { done } = await uninstall.start(r)
        done
          .then(onUninstallDone)
          .catch((error: unknown) => log('프로그램 제거 작업이 비정상 종료되었습니다', error))
        return { started: true as const }
      },
      log
    )(raw)
  )

  // 설치 폴더를 탐색기에서 연다 (renderer 는 경로가 아니라 programId 만 보낸다)
  h(IPC_CHANNELS.programsOpenFolder, (_e, raw: unknown) =>
    wrapHandler(
      programIdSchema,
      async (r) => {
        const path = await service.installLocationOf(r.programId)
        const info = await stat(path).catch(() => null)
        if (!info?.isDirectory()) throw new AppError('NOT_FOUND', '설치 폴더가 더 이상 없습니다.')
        const error = await shell.openPath(path)
        if (error) throw new AppError('INTERNAL', '폴더를 열지 못했습니다.')
        return null
      },
      log
    )(raw)
  )
}
