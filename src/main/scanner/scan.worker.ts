// 스캔 전용 worker 진입점. 메인 스레드/renderer 가 아니라 여기서만 디렉터리를 순회한다 (CLAUDE.md §5-5).
import { parentPort } from 'node:worker_threads'
import { runScan } from './core.ts'
import type { CancelToken } from './core.ts'
import type { WorkerMessage, WorkerRequest } from './protocol.ts'

if (!parentPort) throw new Error('scan.worker 는 worker_threads 안에서만 실행할 수 있습니다.')
const port = parentPort
const token: CancelToken = { cancelled: false }
const send = (message: WorkerMessage): void => port.postMessage(message)

port.on('message', (request: WorkerRequest) => {
  if (request.type === 'cancel') {
    token.cancelled = true
    return
  }
  runScan(request.root, request.options, {
    scanId: request.scanId,
    token,
    ...(request.progressIntervalMs !== undefined
      ? { progressIntervalMs: request.progressIntervalMs }
      : {}),
    onProgress: (progress) => send({ type: 'progress', progress })
  }).then(
    (result) => send({ type: 'done', result }),
    (error: unknown) =>
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  )
})
