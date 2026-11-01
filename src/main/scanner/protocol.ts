// main ↔ scan worker 메시지 형식 (ARCHITECTURE.md §5.4)
import type { ScanOptions, ScanProgress, ScanResult } from '../../shared/types.ts'

export type WorkerRequest =
  | {
      type: 'start'
      scanId: string
      root: string
      options: Partial<ScanOptions>
      progressIntervalMs?: number
    }
  | { type: 'cancel' }

export type WorkerMessage =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; result: ScanResult }
  | { type: 'error'; message: string }
