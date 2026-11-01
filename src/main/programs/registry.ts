// 설치 프로그램 레지스트리 읽기 (읽기 전용).
// CLAUDE.md §5-9: 레지스트리 쓰기 금지. 이 파일에는 읽기 함수만 있고, 쓰기/삭제 함수는 만들지 않는다.
// 네이티브 모듈 없이 PowerShell 의 Get-ChildItem/Get-ItemProperty(읽기 전용 cmdlet)만 쓰는 고정 스크립트를 실행한다.
// 스크립트에 사용자 입력이나 외부 값은 들어가지 않는다.
import { execFile } from 'node:child_process'
import type { ProgramScope } from '../../shared/types.ts'

/** 레지스트리에서 읽은 날것의 항목. 값의 형식은 신뢰하지 않고 parse.ts 가 방어적으로 해석한다 */
export interface RawUninstallEntry {
  scope: ProgramScope
  /** 레지스트리 키 이름 (Uninstall 바로 아래 하위 키) */
  key: string
  values: Record<string, unknown>
}

export interface RegistryReader {
  readUninstallEntries(): Promise<RawUninstallEntry[]>
}

/** 읽을 위치 3곳 (ROADMAP 5단계) */
export const UNINSTALL_LOCATIONS: ReadonlyArray<{ scope: ProgramScope; path: string }> = [
  { scope: 'machine', path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  {
    scope: 'machine-x86',
    path: 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  },
  { scope: 'user', path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' }
]

/** 화면/규칙/제거에 필요한 값 이름만 읽는다 */
export const READ_VALUE_NAMES = [
  'DisplayName',
  'Publisher',
  'DisplayVersion',
  'InstallDate',
  'InstallLocation',
  'EstimatedSize',
  'UninstallString',
  'QuietUninstallString',
  'SystemComponent',
  'ParentKeyName',
  'ReleaseType',
  'WindowsInstaller'
] as const

/** 실행할 PowerShell 스크립트 (고정 문자열). 테스트가 쓰기 동작이 없음을 검사한다 */
export function buildReadScript(): string {
  const roots = UNINSTALL_LOCATIONS.map((l) => `@('${l.scope}','${l.path}')`).join(',')
  const names = READ_VALUE_NAMES.map((n) => `'${n}'`).join(',')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$roots = @(${roots})`,
    `$names = @(${names})`,
    `$out = New-Object System.Collections.ArrayList`,
    `foreach ($r in $roots) {`,
    `  foreach ($k in (Get-ChildItem -LiteralPath $r[1])) {`,
    `    $p = Get-ItemProperty -LiteralPath $k.PSPath`,
    `    $v = [ordered]@{}`,
    `    foreach ($n in $names) { if ($null -ne $p.$n) { $v[$n] = $p.$n } }`,
    `    [void]$out.Add([ordered]@{ scope = $r[0]; key = $k.PSChildName; values = $v })`,
    `  }`,
    `}`,
    `ConvertTo-Json -Compress -Depth 4 -InputObject @($out)`
  ].join('\n')
}

/** PowerShell 출력(JSON)을 항목 배열로. 형식이 이상하면 이상한 항목만 버린다 */
export function parseReadOutput(stdout: string): RawUninstallEntry[] {
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (!text) return []
  const data: unknown = JSON.parse(text)
  const list = Array.isArray(data) ? data : [data]
  const out: RawUninstallEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const { scope, key, values } = item as Record<string, unknown>
    if (scope !== 'machine' && scope !== 'machine-x86' && scope !== 'user') continue
    if (typeof key !== 'string' || key === '') continue
    out.push({
      scope,
      key,
      values:
        typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {}
    })
  }
  return out
}

export class PowerShellRegistryReader implements RegistryReader {
  readUninstallEntries(): Promise<RawUninstallEntry[]> {
    const encoded = Buffer.from(buildReadScript(), 'utf16le').toString('base64')
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(new Error(`설치 프로그램 목록을 읽지 못했습니다: ${error.message}`))
            return
          }
          try {
            resolve(parseReadOutput(stdout))
          } catch {
            reject(new Error('설치 프로그램 목록의 형식이 올바르지 않습니다.'))
          }
        }
      )
    })
  }
}

/**
 * 개발/E2E 전용 가짜 레지스트리: JSON 파일(RawUninstallEntry[])을 읽는다. 가짜 드라이브 모드에서만 쓴다.
 * 이 모드에서는 실제 레지스트리를 읽지 않으므로, 개발 중에 실제 설치된 프로그램의 제거 명령이 실행될 길이 없다.
 */
export class FileRegistryReader implements RegistryReader {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  async readUninstallEntries(): Promise<RawUninstallEntry[]> {
    const { readFile } = await import('node:fs/promises')
    try {
      const data: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      return Array.isArray(data) ? (data as RawUninstallEntry[]) : []
    } catch {
      return []
    }
  }
}
