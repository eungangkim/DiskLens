// UninstallString 안전 파서 (SAFETY.md §6, ROADMAP 9단계). 순수 함수 — 실행하지 않는다.
// 레지스트리 값은 신뢰할 수 없다(특히 HKCU 는 사용자 권한 프로그램이 바꿀 수 있다). 그래서 "알려진 안전한 형태"만 받아들이고
// 조금이라도 이상하면 거부한다:
//  - 셸을 쓰지 않으므로 실행 파일과 인자를 분리해서 돌려준다 (cmd /c, &, |, ; 같은 연결은 인자로 취급되지도 않고 문자 자체를 거부한다)
//  - 실행 파일은 드라이브 절대경로의 존재하는 .exe 여야 한다 (상대경로, UNC, 장치 경로, 환경변수, `..`, 대체 스트림 거부)
//  - 셸/스크립트/시스템 도구(cmd, powershell, wscript, mshta, rundll32, regsvr32 …)와 .bat/.cmd/.msi/.lnk 는 거부
//  - 따옴표 없는 경로에 공백이 있는 경우(C:\Program Files\X\unins000.exe /S)는 "실제로 존재하는 .exe 경계"가 정확히 하나일 때만 받아들인다
//  - Windows Installer(msiexec)는 `/X{GUID}` 또는 `/I{GUID}` 형태만 받아들이고, 실행 파일은 시스템 폴더의 msiexec.exe 로 고정한다

export interface ParsedUninstallCommand {
  kind: 'msi' | 'exe'
  /** 실행할 파일 (절대경로) */
  exe: string
  /** 인자 배열 (셸 없이 그대로 전달) */
  args: string[]
  /** 로그·확인 대화상자에 보여 줄 이름 */
  installerName: string
}

export type CommandRejectReason =
  | 'empty' // 비어 있음
  | 'too-long' // 너무 긺
  | 'control-chars' // 제어문자(줄바꿈 등)
  | 'bad-quoting' // 따옴표가 맞지 않음
  | 'not-absolute' // 드라이브 절대경로가 아님 (상대경로, UNC, 장치 경로)
  | 'bad-path' // `..`, 환경변수(%), 대체 스트림(:), 금지 문자
  | 'not-exe' // .exe 가 아님 (.bat/.cmd/.msi/.lnk 등)
  | 'blocked-program' // 셸·스크립트 호스트·시스템 도구
  | 'not-found' // 실행 파일이 없음
  | 'ambiguous' // 따옴표 없는 경로에서 실행 파일 경계가 둘 이상
  | 'dangerous-args' // 인자에 셸 연결/치환 문자가 있음
  | 'bad-msi-args' // msiexec 인자가 /X{GUID} 또는 /I{GUID} 가 아님
  | 'too-many-args'

export type CommandCheck =
  { ok: true; value: ParsedUninstallCommand } | { ok: false; reason: CommandRejectReason }

export interface CommandEnv {
  /** 파일이 있는지 (폴더는 false) */
  fileExists(path: string): boolean
  /** Windows 시스템 폴더 (예: C:\Windows\System32). msiexec.exe 의 위치 */
  systemDir: string
}

const MAX_LENGTH = 1024
const MAX_ARGS = 16
const MAX_ARG_LENGTH = 512

/** 제거 프로그램이 될 수 없는 실행 파일 이름 (소문자) */
export const BLOCKED_PROGRAMS: ReadonlySet<string> = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'powershell_ise.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'regedit.exe',
  'reg.exe',
  'wmic.exe',
  'sc.exe',
  'net.exe',
  'net1.exe',
  'taskkill.exe',
  'schtasks.exe',
  'certutil.exe',
  'bitsadmin.exe',
  'msbuild.exe',
  'installutil.exe',
  'bash.exe',
  'wsl.exe',
  'forfiles.exe',
  'cmstp.exe',
  'explorer.exe',
  'start.exe',
  'curl.exe',
  'ssh.exe'
])

/** 인자에 허용하지 않는 문자: 셸 연결(& | ;), 리다이렉션(< >), 치환($ ` ^ % !), 와일드카드(* ?) */
const DANGEROUS_ARG_CHARS = /[&|;<>^%!`$*?]/

const GUID = '\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}'
const MSI_ARGS = new RegExp(`^/([XxIi])\\s*(${GUID})$`)

const fail = (reason: CommandRejectReason): CommandCheck => ({ ok: false, reason })

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 32 || c === 127) return true
  }
  return false
}

const basename = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)

/** 실행 파일 경로 검사. 통과하면 null, 아니면 거부 사유 */
function checkExePath(path: string, env: CommandEnv): CommandRejectReason | null {
  if (path.length === 0 || path.length > 260) return 'bad-path'
  if (!/^[A-Za-z]:\\[^\\]/.test(path)) return 'not-absolute' // 상대경로, UNC(\\), 장치 경로(\\?\), 드라이브 루트
  if (/["%/<>|?*]/.test(path) || path.slice(2).includes(':')) return 'bad-path'
  for (const segment of path.slice(3).split('\\')) {
    if (segment === '' || segment === '.' || segment === '..') return 'bad-path'
    if (segment.endsWith(' ') || segment.endsWith('.')) return 'bad-path' // Windows 가 조용히 잘라내는 이름
  }
  const name = basename(path).toLowerCase()
  if (!name.endsWith('.exe')) return 'not-exe'
  if (BLOCKED_PROGRAMS.has(name)) return 'blocked-program'
  if (!env.fileExists(path)) return 'not-found'
  return null
}

/** 인자 문자열을 CommandLineToArgvW 와 같은 규칙(따옴표로 묶기)으로 나눈다. 따옴표 안의 `\"` 같은 이스케이프는 거부 */
function tokenize(text: string): string[] | 'bad-quoting' {
  const args: string[] = []
  let current = ''
  let inQuote = false
  let started = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '"') {
      if (text[i - 1] === '\\') return 'bad-quoting' // \" — 해석이 도구마다 달라 거부
      inQuote = !inQuote
      started = true
    } else if (!inQuote && (ch === ' ' || ch === '\t')) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (inQuote) return 'bad-quoting'
  if (started) args.push(current)
  return args
}

function checkArgs(
  rest: string
): { ok: true; args: string[] } | { ok: false; reason: CommandRejectReason } {
  const text = rest.trim()
  if (text === '') return { ok: true, args: [] }
  if (DANGEROUS_ARG_CHARS.test(text)) return { ok: false, reason: 'dangerous-args' }
  const args = tokenize(text)
  if (args === 'bad-quoting') return { ok: false, reason: 'bad-quoting' }
  if (args.length > MAX_ARGS) return { ok: false, reason: 'too-many-args' }
  if (args.some((a) => a.length > MAX_ARG_LENGTH)) return { ok: false, reason: 'too-long' }
  return { ok: true, args }
}

/** msiexec 형태면 검사해서 돌려준다. msiexec 가 아니면 null */
function parseMsi(raw: string, env: CommandEnv): CommandCheck | null {
  // 실행 파일 부분: msiexec / msiexec.exe (따옴표 선택) 또는 시스템 폴더의 msiexec.exe 절대경로
  const m = /^"?([^"\s]*?)"?(\s.*)?$/.exec(raw)
  if (!m) return null
  const first = (m[1] ?? '').toLowerCase()
  const system = env.systemDir.toLowerCase().replace(/\\+$/, '')
  const isMsi =
    first === 'msiexec' ||
    first === 'msiexec.exe' ||
    first === `${system}\\msiexec.exe` ||
    // SysWOW64 의 msiexec 도 같은 도구다 (32비트 프로그램의 제거 문자열에 흔함)
    first === `${system.replace(/system32$/, 'syswow64')}\\msiexec.exe`
  if (!isMsi) return null
  const args = (m[2] ?? '').trim()
  const parsed = MSI_ARGS.exec(args)
  if (!parsed) return fail('bad-msi-args')
  const exe = `${env.systemDir.replace(/\\+$/, '')}\\msiexec.exe`
  if (!env.fileExists(exe)) return fail('not-found')
  const mode = (parsed[1] as string).toUpperCase()
  return {
    ok: true,
    value: {
      kind: 'msi',
      exe,
      args: [`/${mode}`, (parsed[2] as string).toUpperCase()],
      installerName: 'Windows Installer (msiexec)'
    }
  }
}

export function parseUninstallCommand(raw: unknown, env: CommandEnv): CommandCheck {
  if (typeof raw !== 'string') return fail('empty')
  const text = raw.trim()
  if (text === '') return fail('empty')
  if (text.length > MAX_LENGTH) return fail('too-long')
  if (hasControlChars(text)) return fail('control-chars')

  const msi = parseMsi(text, env)
  if (msi) return msi

  let exePath: string
  let rest: string
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1)
    if (close < 0) return fail('bad-quoting')
    exePath = text.slice(1, close)
    rest = text.slice(close + 1)
    // 닫는 따옴표 바로 뒤에 글자가 붙어 있으면(`"C:\a.exe"x`) 거부
    if (rest !== '' && !/^\s/.test(rest)) return fail('bad-quoting')
    const bad = checkExePath(exePath, env)
    if (bad) return fail(bad)
  } else {
    // 따옴표 없는 명령: 공백마다 끊어 보며 ".exe" 로 끝나는 후보 중 "실제로 있는 파일"을 찾는다
    const found: string[] = []
    let syntactic: CommandRejectReason | null = null
    for (let i = 1; i <= text.length; i++) {
      if (i !== text.length && !/\s/.test(text[i] as string)) continue
      const candidate = text.slice(0, i)
      if (!candidate.toLowerCase().endsWith('.exe')) continue
      const bad = checkExePath(candidate, env)
      if (bad === null) found.push(candidate)
      else syntactic ??= bad
    }
    if (found.length > 1) return fail('ambiguous') // C:\Program.exe 와 C:\Program Files\X\u.exe 가 둘 다 있는 경우 등
    const only = found[0]
    if (only === undefined) {
      // 후보가 아예 없으면 확장자 문제, 있었는데 모두 탈락했으면 그 사유
      return fail(syntactic ?? (/^[A-Za-z]:\\/.test(text) ? 'not-exe' : 'not-absolute'))
    }
    exePath = only
    rest = text.slice(only.length)
  }

  const args = checkArgs(rest)
  if (!args.ok) return fail(args.reason)
  return {
    ok: true,
    value: { kind: 'exe', exe: exePath, args: args.args, installerName: basename(exePath) }
  }
}
