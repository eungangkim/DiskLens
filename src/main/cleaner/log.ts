// 정리 로그 (SAFETY.md §10): 줄 단위 JSON(JSONL). 거부된 요청도 기록한다. 외부로 전송하지 않는다.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CleanupMode } from '../../shared/cleanup.ts'

export interface LogEntry {
  /** 기록 시각 (ISO). 로거가 채운다 */
  t?: string
  op: 'delete' | 'special' | 'confirm' | 'job' | 'admin' | 'uninstall'
  jobId?: string
  path?: string
  mode?: CleanupMode
  result: 'ok' | 'skipped' | 'denied' | 'error' | 'start' | 'end'
  reason?: string
  bytes?: number
  ruleId?: string
  detail?: string
}

export interface CleanupLogger {
  /** 쓰기에 실패하면 reject 한다 (호출자는 작업을 중단한다) */
  write(entry: LogEntry): Promise<void>
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dateStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** `<logDir>/cleanup-YYYY-MM-DD.log` 에 한 줄씩 덧붙인다 */
export function createFileLogger(logDir: string, now: () => number = Date.now): CleanupLogger {
  let ready: Promise<unknown> | null = null
  return {
    async write(entry) {
      ready ??= mkdir(logDir, { recursive: true })
      await ready
      const at = new Date(now())
      const line = JSON.stringify({ ...entry, t: at.toISOString() })
      await appendFile(join(logDir, `cleanup-${dateStamp(at)}.log`), `${line}\n`, 'utf8')
    }
  }
}

/** 테스트/개발용: 메모리에 쌓는다 */
export function createMemoryLogger(): CleanupLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    write(entry) {
      entries.push({ ...entry })
      return Promise.resolve()
    }
  }
}
