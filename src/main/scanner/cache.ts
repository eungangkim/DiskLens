// 스캔 결과 캐시 (ARCHITECTURE.md §5.5, DATA_SPEC.md §4)
// 최근 3개만 유지하되, 오래된 파일을 지우지 않고 고정 슬롯 3개를 번갈아 덮어쓰는 방식을 쓴다.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { ScanResult } from '../../shared/types.ts'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const CACHE_SCHEMA_VERSION = 1
const SLOT_COUNT = 3
const SUFFIX = '.json.gz'

interface CacheFile extends ScanResult {
  schemaVersion: number
}

function driveKey(root: string): string {
  const m = /^([a-z]):/i.exec(root)
  return m?.[1] ? m[1].toUpperCase() : 'root'
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** 저장할 슬롯 선택: 비어 있는 슬롯 우선, 없으면 가장 오래된 슬롯 */
async function pickSlotPath(dir: string, key: string): Promise<string> {
  let oldest: { path: string; mtime: number } | null = null
  for (let i = 0; i < SLOT_COUNT; i++) {
    const path = join(dir, `${key}-slot${i}${SUFFIX}`)
    const mtime = await mtimeOf(path)
    if (mtime === null) return path
    if (!oldest || mtime < oldest.mtime) oldest = { path, mtime }
  }
  return (oldest as { path: string }).path
}

export async function saveScanCache(dir: string, result: ScanResult): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file: CacheFile = { schemaVersion: CACHE_SCHEMA_VERSION, ...result }
  const data = await gzipAsync(Buffer.from(JSON.stringify(file), 'utf8'))
  const path = await pickSlotPath(dir, driveKey(result.summary.root))
  await writeFile(path, data)
  return path
}

function isCacheFile(value: unknown): value is CacheFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<CacheFile>
  return (
    v.schemaVersion === CACHE_SCHEMA_VERSION &&
    typeof v.summary === 'object' &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.topFiles) &&
    Array.isArray(v.typeSummary) &&
    Array.isArray(v.skippedSample)
  )
}

/** 가장 최근 캐시를 불러온다. 없거나 깨졌거나 버전이 다르면 null (안전하게 초기화) */
export async function loadLatestScanCache(dir: string): Promise<ScanResult | null> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(SUFFIX))
  } catch {
    return null
  }
  const withTime: Array<{ path: string; mtime: number }> = []
  for (const name of names) {
    const path = join(dir, name)
    const mtime = await mtimeOf(path)
    if (mtime !== null) withTime.push({ path, mtime })
  }
  withTime.sort((a, b) => b.mtime - a.mtime)
  for (const { path } of withTime) {
    try {
      const parsed: unknown = JSON.parse((await gunzipAsync(await readFile(path))).toString('utf8'))
      if (isCacheFile(parsed)) {
        return {
          summary: parsed.summary,
          nodes: parsed.nodes,
          topFiles: parsed.topFiles,
          typeSummary: parsed.typeSummary,
          skippedSample: parsed.skippedSample
        }
      }
    } catch {
      // 깨진 캐시는 건너뛰고 다음 후보를 시도한다
    }
  }
  return null
}
