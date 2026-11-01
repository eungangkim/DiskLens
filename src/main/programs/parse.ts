// 레지스트리 항목 → 설치 프로그램 (순수 함수). 값이 없거나 형식이 이상해도 던지지 않는다.
import { createHash } from 'node:crypto'
import type { ProgramScope } from '../../shared/types.ts'
import type { RawUninstallEntry } from './registry.ts'

/** main 안에서만 쓰는 내부 형태. 제거 명령은 UI 로 보내지 않는다 (9단계에서 programId 로 다시 찾아 쓴다) */
export interface ProgramRecord {
  id: string
  name: string
  publisher?: string
  version?: string
  installDate?: string
  installLocation?: string
  estimatedSizeBytes?: number
  isSystemComponent: boolean
  scope: ProgramScope
  uninstallCommand?: string
  quietUninstallCommand?: string
}

const SCOPE_ORDER: Record<ProgramScope, number> = { machine: 0, 'machine-x86': 1, user: 2 }
const MAX_TEXT = 500

/** 문자열 값만 받아 다듬는다 (숫자/배열 등 이상한 형식은 없는 것으로 본다) */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = value.replace(/\0/g, '').trim()
  return t === '' ? undefined : t.slice(0, MAX_TEXT)
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

/** InstallDate: YYYYMMDD 또는 YYYY-MM-DD. 실제 존재하는 날짜만 인정한다 */
export function parseInstallDate(value: unknown): string | undefined {
  const raw = typeof value === 'number' ? String(value) : text(value)
  if (!raw) return undefined
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw)
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  const valid =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
  if (!valid || y < 1990 || y > new Date().getUTCFullYear() + 1) return undefined
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** EstimatedSize(KB, DWORD) → 바이트. 0/음수/비정상 값은 없는 것으로 본다 */
export function parseEstimatedSize(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  const bytes = Math.floor(n) * 1024
  // 16 TiB 를 넘는 값은 레지스트리 오염으로 본다
  return bytes > 16 * 1024 ** 4 ? undefined : bytes
}

/** InstallLocation: 따옴표 제거, 드라이브 절대경로만 인정 (상대경로/UNC/URL 제외) */
export function parseInstallLocation(value: unknown): string | undefined {
  let t = text(value)
  if (!t) return undefined
  t = t.replace(/^"+|"+$/g, '').trim()
  if (!/^[A-Za-z]:\\/.test(t)) return undefined
  t = t.replace(/\\+$/, '')
  // 드라이브 루트(C:\) 자체는 설치 폴더로 쓰지 않는다 (모든 폴더가 그 안에 있어 의미가 없다)
  return /^[A-Za-z]:$/.test(t) ? undefined : t
}

const UPDATE_RELEASE_TYPES = new Set(['update', 'hotfix', 'security update', 'service pack'])

function programId(scope: ProgramScope, key: string): string {
  const hash = createHash('sha1')
    .update(`${scope}\\${key}`.toLowerCase())
    .digest('hex')
    .slice(0, 10)
  return `${key.slice(0, 40)}#${hash}`
}

/** 한 항목을 해석한다. 이름(DisplayName)이 없으면 Windows 설정 앱 목록에도 안 나오므로 null */
export function parseEntry(entry: RawUninstallEntry): ProgramRecord | null {
  const v = entry.values
  const name = text(v['DisplayName'])
  if (!name) return null
  const releaseType = text(v['ReleaseType'])?.toLowerCase()
  const isSystemComponent =
    flag(v['SystemComponent']) ||
    text(v['ParentKeyName']) !== undefined ||
    (releaseType !== undefined && UPDATE_RELEASE_TYPES.has(releaseType)) ||
    // 윈도 업데이트 항목(KB1234567)
    /^(Security Update|Update|Hotfix) for .*\(KB\d+\)/i.test(name)

  const record: ProgramRecord = {
    id: programId(entry.scope, entry.key),
    name,
    isSystemComponent,
    scope: entry.scope
  }
  const publisher = text(v['Publisher'])
  if (publisher) record.publisher = publisher
  const version = text(v['DisplayVersion'])
  if (version) record.version = version
  const installDate = parseInstallDate(v['InstallDate'])
  if (installDate) record.installDate = installDate
  const installLocation = parseInstallLocation(v['InstallLocation'])
  if (installLocation) record.installLocation = installLocation
  const size = parseEstimatedSize(v['EstimatedSize'])
  if (size !== undefined) record.estimatedSizeBytes = size
  const uninstall = text(v['UninstallString'])
  if (uninstall) record.uninstallCommand = uninstall
  const quiet = text(v['QuietUninstallString'])
  if (quiet) record.quietUninstallCommand = quiet
  return record
}

/**
 * 같은 프로그램이 여러 위치에 중복 등록된 것을 합친다 (이름·게시자·버전이 같으면 같은 프로그램).
 * machine > machine-x86 > user 순으로 먼저 나온 것을 유지하고, 비어 있는 값은 중복 항목에서 채운다.
 * 시스템 구성요소 여부는 하나라도 아니라고 하면 일반 프로그램으로 본다 (사용자에게 보이는 쪽 우선).
 */
export function dedupe(records: readonly ProgramRecord[]): ProgramRecord[] {
  const sorted = [...records].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
  const byKey = new Map<string, ProgramRecord>()
  for (const r of sorted) {
    const key = [r.name, r.publisher ?? '', r.version ?? ''].join('\u0001').toLowerCase()
    const kept = byKey.get(key)
    if (!kept) {
      byKey.set(key, { ...r })
      continue
    }
    kept.publisher ??= r.publisher
    kept.installDate ??= r.installDate
    kept.installLocation ??= r.installLocation
    kept.estimatedSizeBytes ??= r.estimatedSizeBytes
    kept.uninstallCommand ??= r.uninstallCommand
    kept.quietUninstallCommand ??= r.quietUninstallCommand
    if (!r.isSystemComponent) kept.isSystemComponent = false
  }
  return [...byKey.values()]
}

/** 레지스트리 항목 전체 → 중복 없는 프로그램 목록 */
export function parseEntries(entries: readonly RawUninstallEntry[]): ProgramRecord[] {
  const records: ProgramRecord[] = []
  for (const e of entries) {
    try {
      const r = parseEntry(e)
      if (r) records.push(r)
    } catch {
      // 한 항목이 이상해도 나머지는 계속 처리한다
    }
  }
  return dedupe(records)
}
