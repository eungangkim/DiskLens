// 스캔 worker가 쓰는 libuv 스레드풀을 키운다. 파일 시스템 작업이 시작되기 전에 설정해야 한다.
process.env['UV_THREADPOOL_SIZE'] ??= '16'

import { app, BrowserWindow, shell } from 'electron'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCleanupEngine } from './cleaner/engine'
import { createAdminClient } from './helper/adminClient'
import { createPowerShellElevation } from './helper/elevation'
import { ELEVATED_DIR_NAME } from './helper/jobFiles'
import { parseHelperArgs, runHelperMain } from './helper/helperMain'
import { createFakeTrash, resolveFakeDrive } from './devDrive'
import { registerAppHandlers } from './ipc/app'
import { registerCleanupHandlers } from './ipc/cleanup'
import { loadSettings } from './settings'
import { loadRuleSetFromFiles } from './rules/loader'
import { registerPingHandlers } from './ipc/ping'
import { registerProgramHandlers } from './ipc/programs'
import { registerScanHandlers } from './ipc/scan'
import { ProgramRuleMatcher } from './programs/matcher'
import { FileRegistryReader, PowerShellRegistryReader } from './programs/registry'
import { ProgramService } from './programs/service'
import { UninstallService, createNodeProcessPort } from './programs/uninstall'
import { createFileLogger } from './cleaner/log'
import { verifyHelperEnv } from './helper/env'
import { existsSync, statSync } from 'node:fs'
import { ScanManager } from './scanner/manager'
import { ScanService } from './scanner/service'
import { IPC_CHANNELS } from '../shared/ipc'
import scanWorkerPath from './scanner/scan.worker?modulePath'
import type { SecurityInfo } from '../shared/ipc'

// ARCHITECTURE.md §3: 보안 설정. 이 값을 약화시키지 않는다.
const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true
} as const

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    title: 'DiskLens',
    webPreferences: { ...WEB_PREFERENCES, preload: join(__dirname, '../preload/index.js') }
  })

  win.once('ready-to-show', () => win.show())

  // 새 창/외부 이동 차단 (이번 범위에서는 외부 URL을 열지 않는다)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (app.isPackaged || !devUrl || !url.startsWith(devUrl)) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// 개발 모드 전용 시험 설정: 스캔 루트와 사용자 데이터 폴더를 바꿔 실제 C:\ 대신 작은 폴더로 확인할 수 있다.
// 이 값들은 패키징된 앱(app.isPackaged)에서는 무시된다. 보호 경로/삭제 검사와는 무관하다.
const DEV_USER_DATA = !app.isPackaged ? process.env['DISKLENS_USER_DATA'] : undefined
if (DEV_USER_DATA) app.setPath('userData', DEV_USER_DATA)

function resolveScanRoot(fakeRoot?: string): string {
  if (fakeRoot) return fakeRoot
  const devRoot = !app.isPackaged ? process.env['DISKLENS_SCAN_ROOT'] : undefined
  return devRoot && devRoot.length > 0 ? devRoot : 'C:\\'
}

function logError(message: string, error?: unknown): void {
  console.error(`[DiskLens] ${message}`, error ?? '')
}

/** 열려 있는 모든 창으로 이벤트 전송 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// 시스템 휴지통 이동. 일반 앱과 관리자 헬퍼가 같은 함수를 주입해 쓴다 (삭제 API 호출은 이 한 곳뿐)
const systemTrash = (path: string): Promise<void> => shell.trashItem(path)

// 관리자 헬퍼 모드: 창 없이 job 파일 하나만 처리하고 종료한다. 단일 인스턴스 잠금은 쓰지 않는다.
const helperArgs = parseHelperArgs(process.argv)

// 단일 인스턴스 잠금
if (helperArgs) {
  void runHelperMain(helperArgs, systemTrash)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    // 개발/E2E 전용 가짜 C 드라이브 (패키징된 앱에서는 무시, 임시 폴더 밖이면 시작하지 않는다)
    let fake: ReturnType<typeof resolveFakeDrive>
    try {
      fake = resolveFakeDrive({
        value: process.env['DISKLENS_FAKE_DRIVE'],
        isPackaged: app.isPackaged,
        tmpDir: tmpdir()
      })
    } catch (error) {
      logError('가짜 드라이브 설정이 안전 조건을 만족하지 않아 종료합니다', error)
      app.exit(1)
      return
    }
    const ruleEnv = fake?.env ?? process.env
    // 규칙 DB 로드 (읽기 전용). 거부된 규칙은 경고로 남기고 나머지로 계속 동작한다.
    const rules = await loadRuleSetFromFiles(
      {
        builtin: app.isPackaged
          ? join(process.resourcesPath, 'cleanup-rules.json')
          : join(__dirname, '..', '..', 'resources', 'cleanup-rules.json'),
        user: join(app.getPath('userData'), 'user-rules.json')
      },
      {
        env: ruleEnv,
        appPaths: [
          app.getPath('userData'),
          ...(app.isPackaged ? [dirname(app.getPath('exe'))] : [])
        ]
      }
    )
    for (const i of rules.issues)
      logError(`규칙 거부 [${i.source}/${i.code}] ${i.ruleId}: ${i.message}`)

    registerPingHandlers((): SecurityInfo => ({
      contextIsolation: WEB_PREFERENCES.contextIsolation,
      nodeIntegration: WEB_PREFERENCES.nodeIntegration,
      sandbox: WEB_PREFERENCES.sandbox
    }))

    // 앱 설정 (스캔 루트·제외 폴더·단위·테마·영구 삭제 허용). 저장 전 main 이 다시 검증한다.
    const settings = await loadSettings(join(app.getPath('userData'), 'settings.json'), {
      dirExists: (path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      }
    })
    const scanRef: { current?: ScanService } = {}
    // 제거 명령 검사용 환경: 파일 존재 확인과 Windows 시스템 폴더(msiexec 위치)
    const verifiedWin = verifyHelperEnv(process.env)
    const winDir = fake
      ? (fake.env['WINDIR'] as string)
      : verifiedWin.ok
        ? (verifiedWin.env['WINDIR'] as string)
        : 'C:\\Windows'
    const commandEnv = {
      fileExists: (p: string): boolean => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      },
      systemDir: join(winDir, 'System32')
    }
    // 설치 프로그램 목록 (레지스트리 읽기 전용). 시작 직후 백그라운드로 읽어 둔다.
    const programs = new ProgramService({
      // 가짜 드라이브(개발/E2E)에서는 실제 레지스트리를 읽지 않는다: 실제 설치된 프로그램의 제거 명령이 실행될 길을 없앤다
      reader: fake
        ? new FileRegistryReader(join(fake.root, 'fake-registry.json'))
        : new PowerShellRegistryReader(),
      commandEnv,
      matcher: new ProgramRuleMatcher(rules.programRules),
      // 스캔 서비스는 아래에서 만들어진다. 그 전에는 연결 정보가 없는 것으로 본다.
      scan: { locate: (path) => scanRef.current?.locate(path) ?? null },
      log: logError
    })
    void programs.load().catch((e: unknown) => logError('설치 프로그램 목록 읽기 실패', e))

    // 스캔은 worker 스레드에서만 실행한다 (CLAUDE.md §5-5)
    const service = new ScanService({
      engine: new ScanManager(scanWorkerPath, 250),
      cacheDir: join(app.getPath('userData'), 'scan-cache'),
      // 가짜 드라이브(개발/E2E)에서는 설정의 스캔 루트를 무시한다
      root: () => (fake ? fake.root : (settings.get().scanRoot ?? resolveScanRoot())),
      excludePaths: () => settings.get().excludePaths,
      log: logError,
      rules: rules.matcher,
      // 규칙이 가리키는 폴더 + 설치 프로그램 폴더를 "기타"로 접지 않는다
      scanHints: () => {
        const hints = rules.matcher.scanHints()
        return {
          keepPaths: [...hints.keepPaths, ...programs.installLocations()],
          keepNames: hints.keepNames
        }
      },
      events: {
        onProgress: (p) => broadcast(IPC_CHANNELS.scanProgress, p),
        onDone: (s) => broadcast(IPC_CHANNELS.scanDone, s),
        onError: (m) => broadcast(IPC_CHANNELS.scanError, m)
      }
    })
    scanRef.current = service
    registerScanHandlers(service, logError)
    // 프로그램 제거 (9단계): 공식 제거 프로그램 실행만 한다. 관리자 권한이 필요하면 UAC 로 다시 실행한다 (가짜 드라이브에서는 UAC 없음)
    const uninstall = new UninstallService({
      programs,
      env: commandEnv,
      process: createNodeProcessPort(),
      ...(fake ? {} : { elevation: createPowerShellElevation() }),
      logger: createFileLogger(join(app.getPath('userData'), 'logs')),
      scan: { locate: (path) => scanRef.current?.locate(path) ?? null },
      dirExists: (path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      }
    })
    registerProgramHandlers(
      programs,
      uninstall,
      (result) => broadcast(IPC_CHANNELS.programsUninstallDone, result),
      logError
    )

    // 정리 엔진 (7단계). 휴지통 이동은 shell.trashItem — 가짜 드라이브에서는 실제 휴지통 대신 샌드박스 폴더로 옮긴다.
    const trash = fake ? createFakeTrash(fake.trashDir) : systemTrash
    const cleanup = createCleanupEngine({
      matcher: rules.matcher,
      protectedContext: {
        env: ruleEnv,
        appPaths: [
          app.getPath('userData'),
          ...(app.isPackaged ? [dirname(app.getPath('exe'))] : [])
        ]
      },
      userDataDir: app.getPath('userData'),
      settings: { allowPermanentDelete: () => settings.get().allowPermanentDelete },
      trash,
      // 관리자 권한이 필요한 항목은 UAC 로 상승한 헬퍼에 규칙 ID 만 넘겨 처리한다 (가짜 드라이브에서는 UAC 를 쓰지 않는다)
      ...(fake
        ? {}
        : {
            admin: createAdminClient({
              dir: join(app.getPath('userData'), ELEVATED_DIR_NAME),
              elevation: createPowerShellElevation(),
              launcher: {
                exe: process.execPath,
                baseArgs: app.isPackaged ? [] : [app.getAppPath()]
              }
            })
          }),
      onProgress: (p) => broadcast(IPC_CHANNELS.cleanupProgress, p)
    })
    registerCleanupHandlers(
      cleanup.service,
      cleanup.history,
      settings,
      (result) => broadcast(IPC_CHANNELS.cleanupDone, result),
      logError
    )
    registerAppHandlers({
      info: () => ({
        version: app.getVersion(),
        rulesVersion: rules.rulesVersion,
        ruleCounts: rules.counts,
        ruleIssues: rules.issues.length,
        userRulesPath: join(app.getPath('userData'), 'user-rules.json'),
        userRulesExists: existsSync(join(app.getPath('userData'), 'user-rules.json')),
        logDir: join(app.getPath('userData'), 'logs'),
        userDataDir: app.getPath('userData')
      }),
      allowDialogs: !fake,
      relaunch: () => {
        app.relaunch()
        app.exit(0)
      },
      log: logError
    })
    createWindow()
  })

  app.on('window-all-closed', () => app.quit())
}
