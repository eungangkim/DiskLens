// E2E 공용: 가짜 C 드라이브(임시 폴더)에서 빌드된 앱을 띄운다. 실제 C: 는 절대 건드리지 않는다.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'

const ROOT = process.cwd()

export const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js')

export function electronExe(): string {
  const local = join(ROOT, '.electron-dist2', 'electron.exe')
  return process.env['DISKLENS_ELECTRON_PATH'] ?? (existsSync(local) ? local : 'electron')
}

/** 헬퍼 프로세스용 환경: 가짜 드라이브 + 별도 사용자 데이터 (실제 %APPDATA% 를 건드리지 않는다) */
export function helperEnv(sandboxRoot: string, userData: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['NODE_OPTIONS']
  delete env['ELECTRON_RUN_AS_NODE']
  env['DISKLENS_FAKE_DRIVE'] = sandboxRoot
  env['DISKLENS_USER_DATA'] = userData
  return env
}

export interface Launched {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  userData: string
  close(): Promise<void>
}

export async function launch(sandbox: Sandbox, userData?: string): Promise<Launched> {
  // 사용자 데이터 폴더도 샌드박스 안에 둔다: 삭제는 샌드박스 도우미(dispose)만 한다
  const ud = userData ?? sandbox.mkdir('.e2e-userdata')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['NODE_OPTIONS'] // Electron 은 --use-system-ca 를 허용하지 않는다
  delete env['ELECTRON_RUN_AS_NODE']
  env['DISKLENS_FAKE_DRIVE'] = sandbox.root
  env['DISKLENS_USER_DATA'] = ud
  const app = await electron.launch({
    executablePath: electronExe(),
    args: [MAIN_ENTRY],
    env
  })
  const page = await app.firstWindow()
  return {
    app,
    page,
    sandbox,
    userData: ud,
    async close() {
      await app.close()
    }
  }
}

export { createSandbox }
