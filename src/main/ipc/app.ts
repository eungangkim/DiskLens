// 앱 정보 / 폴더 열기 / 폴더 선택 / 규칙 다시 불러오기 IPC (UI_SPEC §7).
// renderer 는 경로를 보내지 않는다: 열 폴더는 enum('logs'|'userData'), 폴더 선택은 main 이 대화상자를 띄워 결과만 돌려준다.
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppInfo } from '../../shared/ipc.ts'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import { isPlainDrivePath } from '../settings.ts'
import { AppError, wrapHandler } from './errors.ts'
import { openFolderSchema, pickFolderSchema } from './cleanupSchemas.ts'
import { noPayload } from './scan.ts'

export interface AppHandlerDeps {
  info: () => AppInfo
  /** 가짜 드라이브(개발/E2E)에서는 대화상자를 쓰지 않는다 */
  allowDialogs: boolean
  relaunch: () => void
  log: (message: string, error?: unknown) => void
}

export function registerAppHandlers(deps: AppHandlerDeps): void {
  const h = ipcMain.handle.bind(ipcMain)
  const { log } = deps

  h(IPC_CHANNELS.appInfo, (_e, raw: unknown) => wrapHandler(noPayload, () => deps.info(), log)(raw))

  h(IPC_CHANNELS.appOpenFolder, (_e, raw: unknown) =>
    wrapHandler(
      openFolderSchema,
      async (r) => {
        const info = deps.info()
        const dir = r.target === 'logs' ? info.logDir : info.userDataDir
        const error = await shell.openPath(dir)
        if (error)
          throw new AppError(
            'NOT_FOUND',
            '폴더를 열 수 없습니다. 아직 만들어지지 않았을 수 있습니다.'
          )
        return null
      },
      log
    )(raw)
  )

  h(IPC_CHANNELS.settingsPickFolder, (_e, raw: unknown) =>
    wrapHandler(
      pickFolderSchema,
      async (r) => {
        if (!deps.allowDialogs)
          throw new AppError('INVALID_REQUEST', '이 환경에서는 폴더를 고를 수 없습니다.')
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = {
          title: r.purpose === 'scanRoot' ? '스캔할 폴더 선택' : '스캔에서 제외할 폴더 선택',
          properties: ['openDirectory' as const]
        }
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        const picked = result.filePaths[0]
        if (result.canceled || picked === undefined) return null
        if (!isPlainDrivePath(picked))
          throw new AppError('INVALID_REQUEST', '드라이브 폴더(C:\\… 형식)만 고를 수 있습니다.')
        return picked
      },
      log
    )(raw)
  )

  // 사용자 규칙을 다시 읽으려면 규칙을 쓰는 모든 서비스를 새로 만들어야 하므로, 앱을 다시 시작한다
  h(IPC_CHANNELS.appReloadRules, (_e, raw: unknown) =>
    wrapHandler(
      noPayload,
      () => {
        deps.relaunch()
        return null
      },
      log
    )(raw)
  )
}
