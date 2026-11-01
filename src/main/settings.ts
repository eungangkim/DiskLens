// 앱 설정 저장소 (DATA_SPEC.md §4 settings.json).
// 파일이 없거나 깨졌거나 버전이 다르면 안전한 기본값(영구 삭제 꺼짐)으로 시작한다. 항목 하나가 깨져도 그 항목만 기본값으로 돌린다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings } from '../shared/ipc.ts'
import { AppError } from './ipc/errors.ts'

const SCHEMA_VERSION = 2
const MAX_EXCLUDES = 50

export const DEFAULT_SETTINGS: AppSettings = {
  allowPermanentDelete: false,
  sizeUnit: 'GiB',
  theme: 'system',
  scanRoot: null,
  excludePaths: []
}

export interface SettingsStore {
  get(): AppSettings
  /** 검증을 통과한 설정만 저장한다. 통과하지 못하면 이유를 담은 AppError(INVALID_REQUEST)를 던진다 */
  set(next: AppSettings): Promise<AppSettings>
}

/** 드라이브 절대경로(C:\폴더)인가. UNC/장치 경로/상대경로/`..`/대체 스트림은 아니다 */
export function isPlainDrivePath(path: string): boolean {
  if (!/^[A-Za-z]:\\/.test(path)) return false
  if (/["<>|?*]/.test(path) || path.slice(2).includes(':')) return false
  return !path
    .slice(3)
    .split('\\')
    .some(
      (s) => s === '.' || s === '..' || s.endsWith(' ') || s.endsWith('.') || /[\\/]{2}/.test(s)
    )
}

/** 설정 하나하나를 검사해, 깨진 값은 기본값으로 돌린다 (순수 함수) */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const excludes = Array.isArray(r['excludePaths'])
    ? r['excludePaths']
        .filter((p): p is string => typeof p === 'string' && isPlainDrivePath(p))
        .slice(0, MAX_EXCLUDES)
    : []
  return {
    allowPermanentDelete: r['allowPermanentDelete'] === true,
    sizeUnit: r['sizeUnit'] === 'GB' ? 'GB' : 'GiB',
    theme: r['theme'] === 'light' || r['theme'] === 'dark' ? r['theme'] : 'system',
    scanRoot:
      typeof r['scanRoot'] === 'string' && isPlainDrivePath(r['scanRoot']) ? r['scanRoot'] : null,
    excludePaths: [...new Set(excludes)]
  }
}

/** 저장 전 검증 (순수 함수). 문제가 있으면 한국어 이유, 없으면 null */
export function validateSettings(
  next: AppSettings,
  dirExists: (path: string) => boolean
): string | null {
  if (next.scanRoot !== null) {
    if (!isPlainDrivePath(next.scanRoot))
      return '스캔 루트는 C:\\ 처럼 드라이브로 시작하는 폴더여야 합니다.'
    if (!dirExists(next.scanRoot)) return '스캔 루트 폴더를 찾을 수 없습니다.'
  }
  if (next.excludePaths.length > MAX_EXCLUDES) return `제외 폴더는 최대 ${MAX_EXCLUDES}개입니다.`
  for (const p of next.excludePaths) {
    if (!isPlainDrivePath(p)) return `제외 폴더 경로가 올바르지 않습니다: ${p}`
  }
  return null
}

export async function loadSettings(
  path: string,
  options: { dirExists?: (path: string) => boolean } = {}
): Promise<SettingsStore> {
  let current: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: unknown }
    // 버전 1(영구 삭제 설정 하나)도 같은 이름의 값은 그대로 이어받는다
    if (data.schemaVersion === SCHEMA_VERSION || data.schemaVersion === 1) {
      current = sanitizeSettings(data)
    }
  } catch {
    // 없거나 깨진 파일: 기본값
  }
  const dirExists = options.dirExists ?? ((): boolean => true)
  const snapshot = (): AppSettings => ({ ...current, excludePaths: [...current.excludePaths] })
  return {
    get: snapshot,
    async set(next) {
      const problem = validateSettings(next, dirExists)
      if (problem) throw new AppError('INVALID_REQUEST', problem)
      const value = sanitizeSettings(next)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...value }), 'utf8')
      await rename(tmp, path)
      current = value
      return snapshot()
    }
  }
}
