// 개발/E2E 전용 "가짜 C 드라이브" (ARCHITECTURE.md §6 개발 모드 전용 시험 설정, SAFETY.md §11).
// 환경변수 DISKLENS_FAKE_DRIVE 가 임시 폴더를 가리키면, 규칙·보호 경로의 환경변수(%WINDIR% 등)를 그 폴더 안으로 돌리고
// 스캔 루트도 그 폴더로 한다. 보호 경로 검사는 꺼지지 않는다 — 같은 하드코딩 목록이 가짜 드라이브 기준으로 동작한다.
// 안전장치: 패키징된 앱에서는 무시, 폴더가 os.tmpdir() 아래이고 `disklens-` 로 시작하는 폴더 안일 때만 허용한다.
import { mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

export interface FakeDrive {
  root: string
  env: Record<string, string>
  /** 휴지통 대신 쓰는 폴더 (실제 휴지통을 건드리지 않는다) */
  trashDir: string
}

/** 가짜 드라이브용 "휴지통": 실제 휴지통 대신 샌드박스의 .trash 폴더로 옮긴다 (일반 앱·관리자 헬퍼 공용) */
export function createFakeTrash(trashDir: string): (path: string) => Promise<void> {
  return (path) => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(path, join(trashDir, `${Date.now()}-${basename(path)}`))
    return Promise.resolve()
  }
}

export function fakeDriveEnv(root: string): Record<string, string> {
  return {
    SYSTEMDRIVE: root,
    WINDIR: join(root, 'Windows'),
    USERPROFILE: join(root, 'Users', 'tester'),
    LOCALAPPDATA: join(root, 'Users', 'tester', 'AppData', 'Local'),
    APPDATA: join(root, 'Users', 'tester', 'AppData', 'Roaming'),
    PROGRAMDATA: join(root, 'ProgramData'),
    PROGRAMFILES: join(root, 'Program Files'),
    'PROGRAMFILES(X86)': join(root, 'Program Files (x86)')
  }
}

/** 값이 없거나 패키징된 앱이면 null. 값이 있는데 안전 조건을 어기면 예외 (조용히 실제 C:\ 로 동작하지 않게) */
export function resolveFakeDrive(options: {
  value: string | undefined
  isPackaged: boolean
  tmpDir: string
}): FakeDrive | null {
  if (options.isPackaged || !options.value) return null
  const root = realpathSync.native(resolve(options.value))
  const tmp = realpathSync.native(options.tmpDir)
  const prefix = tmp.endsWith(sep) ? tmp : tmp + sep
  const rest = root.toLowerCase().startsWith(prefix.toLowerCase())
    ? root.slice(prefix.length)
    : null
  if (
    rest === null ||
    !rest.toLowerCase().startsWith('disklens-') ||
    !statSync(root).isDirectory()
  ) {
    throw new Error(
      'DISKLENS_FAKE_DRIVE 는 임시 폴더(os.tmpdir()) 아래의 disklens- 로 시작하는 폴더만 가리킬 수 있습니다.'
    )
  }
  return { root, env: fakeDriveEnv(root), trashDir: join(root, '.trash') }
}
