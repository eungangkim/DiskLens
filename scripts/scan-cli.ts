// 스캔 엔진 CLI: npm run scan:cli -- <경로> [--no-allocated] [--save-cache <폴더>] [--concurrency N] [--top N]
// 읽기 전용 도구. 파일을 지우거나 수정하지 않는다. 걸린 시간과 최대 메모리 사용량을 출력한다.
// 파일 시스템 작업이 시작되기 전에 libuv 스레드풀 크기를 키운다.
process.env['UV_THREADPOOL_SIZE'] ??= '16'

import { resolve } from 'node:path'
import { ScanManager } from '../src/main/scanner/manager.ts'
import { saveScanCache } from '../src/main/scanner/cache.ts'
import type { FolderNode, ScanOptions } from '../src/shared/types.ts'

const GiB = 1024 ** 3
const fmt = (bytes: number): string =>
  bytes >= GiB
    ? `${(bytes / GiB).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${(bytes / 1024).toFixed(1)} KiB`

function parseArgs(argv: string[]): {
  root: string
  options: Partial<ScanOptions>
  saveCache?: string
  top: number
} {
  const options: Partial<ScanOptions> = {}
  let root = ''
  let saveCache: string | undefined
  let top = 15
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--no-allocated') options.allocatedSize = false
    else if (a === '--save-cache') saveCache = resolve(argv[++i] ?? '')
    else if (a === '--concurrency') options.concurrency = Number(argv[++i])
    else if (a === '--top') top = Number(argv[++i])
    else if (!a.startsWith('--')) root = a
  }
  if (!root) {
    console.error(
      '사용법: npm run scan:cli -- <경로> [--no-allocated] [--save-cache <폴더>] [--concurrency N] [--top N]'
    )
    process.exit(2)
  }
  return { root, options, top, ...(saveCache ? { saveCache } : {}) }
}

const { root, options, saveCache, top } = parseArgs(process.argv.slice(2))
const manager = new ScanManager(new URL('../src/main/scanner/scan.worker.ts', import.meta.url))

// 최대 메모리: 워커 스레드는 같은 프로세스라 프로세스 전체 RSS를 본다
let peakRss = 0
const sample = (): void => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}
const memTimer = setInterval(sample, 200)

let lastLine = 0
manager.onProgress((p) => {
  const now = Date.now()
  if (now - lastLine < 1000) return
  lastLine = now
  const path = p.currentPath.length > 60 ? '…' + p.currentPath.slice(-59) : p.currentPath
  process.stderr.write(
    `\r[${(p.elapsedMs / 1000).toFixed(0)}s] 파일 ${p.filesScanned.toLocaleString()} | ${fmt(p.bytesScanned)} | 건너뜀 ${p.skippedCount.toLocaleString()} | ${path}`.padEnd(
      150
    )
  )
})

process.on('SIGINT', () => manager.cancel())

const t0 = performance.now()
const handle = manager.start(root, options)
let result: Awaited<typeof handle.result>
try {
  result = await handle.result
} catch (error) {
  console.error(`
스캔 실패: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const elapsedSec = (performance.now() - t0) / 1000
clearInterval(memTimer)
sample()
const maxRssFromOs = process.resourceUsage().maxRSS * 1024 // KiB → bytes
peakRss = Math.max(peakRss, maxRssFromOs)
process.stderr.write('\n')

const s = result.summary
console.log('=== 스캔 요약 ===')
console.log(`루트: ${s.root}${s.cancelled ? '  (취소됨 - 부분 결과)' : ''}`)
console.log(`걸린 시간: ${elapsedSec.toFixed(1)}초`)
console.log(`최대 메모리(프로세스 전체 RSS): ${(peakRss / 1024 ** 2).toFixed(0)} MiB`)
console.log(`크기 기준: ${s.allocatedSize ? '디스크 점유(클러스터 올림)' : '논리 크기'}`)
console.log(
  `총 용량: ${fmt(s.totalBytes)} | 파일 ${s.totalFiles.toLocaleString()}개 | 폴더 ${s.totalDirs.toLocaleString()}개`
)
console.log(
  `건너뜀: ${s.skippedCount.toLocaleString()}개 (샘플 ${result.skippedSample.length}개 보관)`
)
const reasons = new Map<string, number>()
for (const k of result.skippedSample) reasons.set(k.reason, (reasons.get(k.reason) ?? 0) + 1)
if (reasons.size > 0)
  console.log('  샘플 사유: ' + [...reasons].map(([k, v]) => `${k}=${v}`).join(', '))
console.log(
  `보관된 폴더 노드: ${result.nodes.length.toLocaleString()}개 (작은 폴더는 "기타"로 접힘)`
)
if (s.driveInfo)
  console.log(`드라이브: 전체 ${fmt(s.driveInfo.totalBytes)}, 여유 ${fmt(s.driveInfo.freeBytes)}`)

const byId = new Map<string, FolderNode>(result.nodes.map((n) => [n.id, n]))
const rootNode = byId.get(s.rootNodeId)
if (rootNode) {
  console.log(`\n=== 루트 바로 아래 큰 폴더 Top ${top} ===`)
  for (const id of rootNode.childIds.slice(0, top)) {
    const c = byId.get(id)
    if (c)
      console.log(
        `${fmt(c.size).padStart(11)}  ${c.fileCount.toLocaleString().padStart(10)}개  ${c.name}${c.isLink ? ' (링크)' : ''}${c.truncated ? ' (일부 접근 불가)' : ''}`
      )
  }
}
console.log(`\n=== 큰 파일 Top ${Math.min(top, 10)} ===`)
for (const f of result.topFiles.slice(0, Math.min(top, 10)))
  console.log(`${fmt(f.size).padStart(11)}  ${f.path}`)
console.log('\n=== 유형별 ===')
for (const t of result.typeSummary)
  console.log(
    `${t.type.padEnd(11)} ${fmt(t.bytes).padStart(11)}  ${t.fileCount.toLocaleString()}개`
  )

if (saveCache) {
  const t1 = performance.now()
  const path = await saveScanCache(saveCache, result)
  console.log(`\n캐시 저장: ${path} (${((performance.now() - t1) / 1000).toFixed(1)}초)`)
}
