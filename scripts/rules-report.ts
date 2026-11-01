// 규칙 보강용 보고서: 스캔 결과에서 규칙에 걸리지 않은(unknown) 용량 비율과 큰 unknown 폴더 상위 N개를 출력한다.
// 사용법: npm run rules:report -- <경로> [--cache <폴더>] [--top 20]
// 읽기 전용 도구. 파일을 지우거나 수정하지 않는다 (--cache 폴더에는 스캔 결과 파일만 쓴다).
process.env['UV_THREADPOOL_SIZE'] ??= '16'

import { resolve } from 'node:path'
import { loadRuleSetFromFiles } from '../src/main/rules/loader.ts'
import { loadLatestScanCache, saveScanCache } from '../src/main/scanner/cache.ts'
import { ScanManager } from '../src/main/scanner/manager.ts'
import type { FolderNode, ScanResult } from '../src/shared/types.ts'

const GiB = 1024 ** 3
const fmt = (b: number): string =>
  b >= GiB ? `${(b / GiB).toFixed(2)} GiB` : `${(b / 1024 ** 2).toFixed(1)} MiB`

const args = process.argv.slice(2)
let root = ''
let cacheDir: string | undefined
let top = 20
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string
  if (a === '--cache') cacheDir = resolve(args[++i] ?? '')
  else if (a === '--top') top = Number(args[++i])
  else if (!a.startsWith('--')) root = a
}
if (!root) {
  console.error('사용법: npm run rules:report -- <경로> [--cache <폴더>] [--top 20]')
  process.exit(2)
}

const rules = await loadRuleSetFromFiles(
  { builtin: resolve('resources/cleanup-rules.json') },
  { env: process.env }
)
console.log(
  `규칙 ${rules.counts.builtin}개 로드 (버전 ${rules.rulesVersion}), 거부 ${rules.issues.length}건`
)
for (const i of rules.issues) console.log(`  거부: ${i.ruleId} [${i.code}] ${i.message}`)
const matcher = rules.matcher

let result: ScanResult | null = cacheDir ? await loadLatestScanCache(cacheDir) : null
if (result) {
  console.log(`캐시 사용: ${result.summary.finishedAt} 스캔 결과 (${result.summary.root})`)
} else {
  const manager = new ScanManager(new URL('../src/main/scanner/scan.worker.ts', import.meta.url))
  let peak = 0
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200)
  const t0 = performance.now()
  const handle = manager.start(root, matcher.scanHints())
  result = await handle.result
  clearInterval(timer)
  peak = Math.max(peak, process.resourceUsage().maxRSS * 1024)
  console.log(
    `스캔: ${((performance.now() - t0) / 1000).toFixed(1)}초, 최대 메모리 ${(peak / 1024 ** 2).toFixed(0)} MiB, 노드 ${result.nodes.length.toLocaleString()}개`
  )
  if (cacheDir) await saveScanCache(cacheDir, result)
}

const byId = new Map<string, FolderNode>(result.nodes.map((n) => [n.id, n]))
const rootNode = byId.get(result.summary.rootNodeId)
if (!rootNode) throw new Error('루트 노드를 찾을 수 없습니다')

// --- 1) 용량을 안전도별로 나눈다 ---
// 규칙이 하위로 상속되는 폴더(inherited)는 통째로 그 안전도로 센다. 자기 자신에만 적용되는 규칙(exact)이거나
// 규칙이 없는 폴더는 하위로 내려가고, 그 폴더의 직계 파일/접힌 작은 폴더는 규칙 없음(unknown)으로 센다.
const bucket = { safe: 0, caution: 0, protected: 0, unknown: 0 }
const walk = (n: FolderNode): void => {
  const inherited = matcher.lookupSubtree(n.path)
  if (inherited.safety !== 'unknown') {
    bucket[inherited.safety] += n.size
    return
  }
  for (const id of n.childIds) {
    const c = byId.get(id)
    if (c) walk(c)
  }
  bucket.unknown += n.ownFilesSize + (n.collapsed?.size ?? 0)
}
walk(rootNode)
// 큰 파일 중 파일 규칙(pagefile.sys 등)에 걸리는 것은 unknown 에서 옮긴다
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('\\'), 0)) || p
for (const f of result.topFiles) {
  if (matcher.lookupSubtree(dirOf(f.path)).safety !== 'unknown') continue // 폴더 규칙으로 이미 셈
  const s = matcher.lookup(f.path).match.safety
  if (s !== 'unknown') {
    bucket[s] += f.size
    bucket.unknown -= f.size
  }
}
const total = result.summary.totalBytes
console.log(`\n=== 규칙 적용 현황 (총 ${fmt(total)}) ===`)
for (const k of ['safe', 'caution', 'protected', 'unknown'] as const) {
  console.log(
    `${k.padEnd(10)} ${fmt(bucket[k]).padStart(11)}  ${((bucket[k] / total) * 100).toFixed(1)}%`
  )
}

// --- 2) 큰 unknown 폴더 (서로 겹치지 않게) ---
// 규칙이 없는 폴더는 용량의 절반 이상이 하위 폴더 하나에 있으면 그 안쪽으로 내려가고, 아니면 그 폴더를 하나의 항목으로 센다.
// 자기 자신에만 적용되는 규칙(예: C:\Users)이 있는 폴더는 단순한 통로이므로 항상 안쪽으로 내려간다.
const items: FolderNode[] = []
const visit = (n: FolderNode): void => {
  if (matcher.lookupSubtree(n.path).safety !== 'unknown') return
  const selfClassified = matcher.lookup(n.path).match.safety !== 'unknown'
  const children = n.childIds.map((id) => byId.get(id)).filter((c): c is FolderNode => !!c)
  const dominant = children.some((c) => c.size >= n.size * 0.5)
  if (selfClassified || dominant) {
    for (const c of children) visit(c)
    return
  }
  if (!n.isLink) items.push(n)
}
for (const id of rootNode.childIds) {
  const c = byId.get(id)
  if (c) visit(c)
}
items.sort((a, b) => b.size - a.size)
console.log(`\n=== 규칙에 안 걸린 큰 폴더 상위 ${top} ===`)
items.slice(0, top).forEach((n, i) => {
  const pct = ((n.size / total) * 100).toFixed(1)
  console.log(
    `${String(i + 1).padStart(2)}. ${fmt(n.size).padStart(11)} (${pct.padStart(4)}%)  파일 ${n.fileCount.toLocaleString().padStart(9)}개  ${n.path}`
  )
})
const listed = items.slice(0, top).reduce((s, n) => s + n.size, 0)
console.log(
  `\n위 ${Math.min(top, items.length)}개 합계: ${fmt(listed)} (${((listed / total) * 100).toFixed(1)}%)`
)
