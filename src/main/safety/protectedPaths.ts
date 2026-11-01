// 하드코딩 보호 경로 (SAFETY.md §3)와 정리 허용 예외 (SAFETY.md §5). 규칙 DB와 독립이다.
// 이 목록을 줄이는 변경은 사용자 승인이 필요하다. 4단계에서는 "읽기 전용 판정"(화면 표시, 규칙 검증)에만 쓰이고,
// 삭제 관문(DeleteGuard, deleteGuard.ts)은 이 모듈 위에 만들어져 있다 (6단계).
import { expandEnv, globToRegExp, normalizeKey, type RuleEnv } from '../rules/paths.ts'

interface ZoneDef {
  /** 환경변수 허용 패턴. `*` 는 한 구간 와일드카드 (사용자 이름 자리 등) */
  pattern: string
  /** true 면 하위 전부 보호, false 면 그 경로 자체만 보호 */
  descendants: boolean
}

const USERS = '%SYSTEMDRIVE%\\Users\\*'

/** SAFETY.md §3.1 */
const ZONE_DEFS: readonly ZoneDef[] = [
  { pattern: '%SYSTEMDRIVE%\\', descendants: false }, // 드라이브 루트 자체
  { pattern: '%WINDIR%', descendants: true },
  { pattern: '%PROGRAMFILES%', descendants: true },
  { pattern: '%PROGRAMFILES(X86)%', descendants: true },
  // 선택 제한: 문서는 ProgramData 의 Microsoft/드라이버/보안 폴더만 말하지만, 그 밖의 폴더는
  // 어떤 앱이 쓰는지 알 수 없으므로 전체를 보호한다 (더 안전한 쪽으로 해석).
  { pattern: '%PROGRAMDATA%', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\System Volume Information', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\$Recycle.Bin', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\Recovery', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\Boot', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\EFI', descendants: true },
  { pattern: '%SYSTEMDRIVE%\\Users', descendants: false },
  { pattern: USERS, descendants: false }, // 각 사용자 폴더 루트
  { pattern: `${USERS}\\AppData`, descendants: false },
  { pattern: `${USERS}\\AppData\\Local`, descendants: false },
  { pattern: `${USERS}\\AppData\\Roaming`, descendants: false },
  { pattern: `${USERS}\\AppData\\LocalLow`, descendants: false },
  ...['Documents', 'Desktop', 'Pictures', 'Videos', 'Music', 'Downloads', 'OneDrive'].map(
    (name): ZoneDef => ({ pattern: `${USERS}\\${name}`, descendants: true })
  ),
  ...['.ssh', '.gnupg', '.aws', '.kube'].map((name): ZoneDef => ({
    pattern: `${USERS}\\${name}`,
    descendants: true
  })),
  { pattern: `${USERS}\\ntuser.dat*`, descendants: false },
  { pattern: '%SYSTEMDRIVE%\\pagefile.sys', descendants: false },
  { pattern: '%SYSTEMDRIVE%\\hiberfil.sys', descendants: false },
  { pattern: '%SYSTEMDRIVE%\\swapfile.sys', descendants: false },
  { pattern: '%SYSTEMDRIVE%\\bootmgr', descendants: false },
  { pattern: '%SYSTEMDRIVE%\\BOOTNXT', descendants: false }
]

interface ExemptionDef {
  /** 이 폴더와 하위는 보호 구역 안이어도 정리 규칙을 둘 수 있다 */
  pattern: string
  /** 있으면 규칙의 cleanup.specialAction 이 같아야만 예외 (파일을 직접 지우지 않는 전용 동작) */
  specialAction?: 'empty-recycle-bin' | 'run-disk-cleanup'
}

/** SAFETY.md §5: 보호 구역 안에서 정리를 허용하는, 정확히 열거된 하위 경로. 보호 구역 밖의 항목은 여기에 적지 않는다 */
const EXEMPTION_DEFS: readonly ExemptionDef[] = [
  { pattern: '%WINDIR%\\Temp' },
  { pattern: '%WINDIR%\\SoftwareDistribution\\Download' },
  { pattern: '%WINDIR%\\Logs\\CBS' },
  { pattern: '%WINDIR%\\Minidump' },
  { pattern: '%SYSTEMDRIVE%\\$Recycle.Bin', specialAction: 'empty-recycle-bin' }
]

/**
 * 폴더 위치와 상관없이 항상 삭제 거부하는 파일 이름 (SAFETY.md §3.1: 브라우저 로그인/북마크/비밀번호/쿠키, 시스템 파일).
 * 규칙이 캐시 폴더만 가리켜도 그 안에 이런 이름이 있으면 지우지 않는다 (이중 방어).
 */
const PROTECTED_NAME_RES: readonly RegExp[] = [
  /^(login data|login data for account|web data|cookies|bookmarks|history|favicons|preferences|secure preferences|local state|key[34]\.db|logins\.json|cookies\.sqlite|places\.sqlite)(-journal|-wal|-shm)?$/,
  /^(pagefile|hiberfil|swapfile)\.sys$/,
  /^(bootmgr|bootnxt)$/,
  /^ntuser\.dat.*$/
]

export function isProtectedFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return PROTECTED_NAME_RES.some((re) => re.test(lower))
}

export interface ProtectedContext {
  env: RuleEnv
  /** 이 앱 자신의 설치 폴더와 사용자 데이터 폴더 (SAFETY.md §3.1 마지막 항목) */
  appPaths?: readonly string[]
}

export type PathStatus = 'free' | 'protected' | 'exempt'

export interface ProtectedPaths {
  /** 정규화 키(소문자) 기준 판정. specialAction 이 필요한 예외는 일치할 때만 exempt */
  status(key: string, specialAction?: string): PathStatus
  /** 화면 표시용: 보호 구역 안이고 정리 허용 예외가 아니면 true (예외는 specialAction 없이도 "구역 밖"으로 취급) */
  isProtectedForDisplay(path: string): boolean
}

interface Compiled {
  re: RegExp
  specialAction?: string
}

function compile(
  defs: ReadonlyArray<{ pattern: string; descendants: boolean; specialAction?: string }>,
  env: RuleEnv
): Compiled[] {
  const out: Compiled[] = []
  for (const def of defs) {
    const expanded = expandEnv(def.pattern, env)
    if (!expanded.ok) continue // 환경변수가 없는 환경에서는 그 구역을 만들 수 없다 (테스트용 env 등)
    const compiled: Compiled = { re: globToRegExp(normalizeKey(expanded.value), def.descendants) }
    if (def.specialAction) compiled.specialAction = def.specialAction
    out.push(compiled)
  }
  return out
}

export function createProtectedPaths(context: ProtectedContext): ProtectedPaths {
  const zones = compile(ZONE_DEFS, context.env)
  for (const app of context.appPaths ?? []) {
    zones.push({ re: globToRegExp(normalizeKey(app), true) })
  }
  const exemptions = compile(
    EXEMPTION_DEFS.map((e) => ({ ...e, descendants: true })),
    context.env
  )

  const status = (key: string, specialAction?: string): PathStatus => {
    if (!zones.some((z) => z.re.test(key))) return 'free'
    const exempt = exemptions.some(
      (e) => e.re.test(key) && (e.specialAction === undefined || e.specialAction === specialAction)
    )
    return exempt ? 'exempt' : 'protected'
  }

  return {
    status,
    isProtectedForDisplay: (path) => {
      const key = normalizeKey(path)
      // 표시용에서는 전용 동작이 필요한 예외(휴지통)도 규칙이 따로 설명하므로 예외로 본다
      const inZone = zones.some((z) => z.re.test(key))
      if (!inZone) return false
      return !exemptions.some((e) => e.re.test(key))
    }
  }
}
