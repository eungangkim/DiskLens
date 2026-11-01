// 정리 기록 (DATA_SPEC.md §4 cleanup-history.json): 최근 500개. schemaVersion 이 다르면 안전하게 비운다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CleanupRecord } from '../../shared/cleanup.ts'

const SCHEMA_VERSION = 1
const MAX_RECORDS = 500

export interface CleanupHistory {
  add(record: CleanupRecord): Promise<void>
  list(): Promise<CleanupRecord[]>
}

function isRecord(value: unknown): value is CleanupRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.jobId === 'string' &&
    typeof r.at === 'string' &&
    (r.mode === 'trash' || r.mode === 'permanent') &&
    typeof r.freedBytes === 'number' &&
    Array.isArray(r.itemIds)
  )
}

export function createFileHistory(path: string): CleanupHistory {
  const list = async (): Promise<CleanupRecord[]> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    try {
      const data = JSON.parse(text) as { schemaVersion?: unknown; records?: unknown }
      if (data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.records)) return []
      return data.records.filter(isRecord)
    } catch {
      return [] // 깨진 파일은 기록 없음으로 취급한다 (다음 저장 때 새로 쓴다)
    }
  }
  return {
    list,
    async add(record) {
      const records = [...(await list()), record].slice(-MAX_RECORDS)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }), 'utf8')
      await rename(tmp, path)
    }
  }
}

export function createMemoryHistory(): CleanupHistory & { records: CleanupRecord[] } {
  const records: CleanupRecord[] = []
  return {
    records,
    add(record) {
      records.push(record)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...records])
  }
}
