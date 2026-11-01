import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { ScanOptions, ScanProgress, ScanResult } from '../../shared/types.ts'
import type { WorkerMessage, WorkerRequest } from './protocol.ts'

export interface ScanHandle {
  scanId: string
  result: Promise<ScanResult>
}

/** ARCHITECTURE.md §13: 스캔 엔진 교체 지점 */
export interface ScanEngine {
  start(root: string, options?: Partial<ScanOptions>): ScanHandle
  cancel(): void
  onProgress(callback: (progress: ScanProgress) => void): () => void
}

export class ScanManager implements ScanEngine {
  #workerUrl: URL | string
  #worker: Worker | null = null
  #listeners = new Set<(progress: ScanProgress) => void>()
  #progressIntervalMs: number | undefined

  /** workerUrl: scan.worker 파일 위치 (개발/CLI는 .ts, 빌드 후에는 번들된 .js) */
  constructor(workerUrl: URL | string, progressIntervalMs?: number) {
    this.#workerUrl = workerUrl
    this.#progressIntervalMs = progressIntervalMs
  }

  onProgress(callback: (progress: ScanProgress) => void): () => void {
    this.#listeners.add(callback)
    return () => this.#listeners.delete(callback)
  }

  start(root: string, options: Partial<ScanOptions> = {}): ScanHandle {
    if (this.#worker) throw new Error('SCAN_ALREADY_RUNNING')
    const scanId = randomUUID()
    const worker = new Worker(this.#workerUrl, {
      // 메모리 목표(1.5GB)를 넘으면 조기에 알 수 있도록 한도를 명시한다
      resourceLimits: { maxOldGenerationSizeMb: 4096 }
    })
    this.#worker = worker

    const result = new Promise<ScanResult>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        this.#worker = null
        void worker.terminate()
        action()
      }
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'progress') {
          for (const listener of this.#listeners) listener(message.progress)
        } else if (message.type === 'done') {
          finish(() => resolve(message.result))
        } else {
          finish(() => reject(new Error(message.message)))
        }
      })
      worker.on('error', (error) => finish(() => reject(error)))
      worker.on('exit', (code) =>
        finish(() => reject(new Error(`스캔 worker가 예기치 않게 종료되었습니다 (code ${code})`)))
      )
    })

    const request: WorkerRequest = {
      type: 'start',
      scanId,
      root,
      options,
      ...(this.#progressIntervalMs !== undefined
        ? { progressIntervalMs: this.#progressIntervalMs }
        : {})
    }
    worker.postMessage(request)
    return { scanId, result }
  }

  cancel(): void {
    const request: WorkerRequest = { type: 'cancel' }
    this.#worker?.postMessage(request)
  }
}
