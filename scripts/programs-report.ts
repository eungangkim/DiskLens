// 설치 프로그램 보고서: 레지스트리(읽기 전용)에서 프로그램을 읽어 개수와 큰 프로그램 상위 N개를 출력한다.
// 사용법: npm run programs:report -- [--cache <폴더>] [--top 10] [--out <파일>]
//   --cache: rules:report 가 저장한 스캔 캐시가 있으면 설치 폴더 용량(스캔 결과)을 함께 비교한다.
//   --out:   전체 목록을 텍스트 파일로 저장한다 (Windows 설정의 앱 목록과 대조용).
// 읽기 전용 도구. 레지스트리나 파일을 수정하지 않는다 (--out 으로 지정한 파일만 쓴다).
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProgramRuleMatcher } from '../src/main/programs/matcher.ts'
import { PowerShellRegistryReader } from '../src/main/programs/registry.ts'
import { ProgramService } from '../src/main/programs/service.ts'
import { loadRuleSetFromFiles } from '../src/main/rules/loader.ts'
import { loadLatestScanCache } from '../src/main/scanner/cache.ts'
import { buildIndex, findNodeByPath } from '../src/main/scanner/view.ts'

const MiB = 1024 ** 2
const fmt = (b: number | undefined): string => {
  if (b === undefined) return '—'
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GiB` : `${(b / MiB).toFixed(1)} MiB`
}

const args = process.argv.slice(2)
let cacheDir: string | undefined
let out: string | undefined
let top = 10
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string
  if (a === '--cache') cacheDir = resolve(args[++i] ?? '')
  else if (a === '--out') out = resolve(args[++i] ?? '')
  else if (a === '--top') top = Number(args[++i])
}

const rules = await loadRuleSetFromFiles(
  { builtin: resolve('resources/cleanup-rules.json') },
  { env: process.env }
)
console.log(
  `프로그램 규칙 ${rules.programRules.length}개 로드, 거부 ${rules.issues.filter((i) => i.ruleId.startsWith('prog-')).length}건`
)

const scan = cacheDir ? await loadLatestScanCache(cacheDir) : null
const index = scan ? buildIndex(scan) : null
if (scan) console.log(`스캔 캐시 사용: ${scan.summary.finishedAt} (${scan.summary.root})`)

const service = new ProgramService({
  reader: new PowerShellRegistryReader(),
  matcher: new ProgramRuleMatcher(rules.programRules),
  ...(index
    ? {
        scan: {
          locate: (p: string) => {
            const n = findNodeByPath(index, p)
            return n ? { scanId: index.result.summary.scanId, nodeId: n.id, size: n.size } : null
          }
        }
      }
    : {}),
  log: (m, e) => console.error(m, e)
})

const t0 = performance.now()
const all = await service.list(true, false)
const ms = performance.now() - t0
const visible = all.filter((p) => !p.isSystemComponent)
console.log(`\n레지스트리 읽기 ${(ms / 1000).toFixed(1)}초`)
console.log(`인식된 항목: 전체 ${all.length}개`)
console.log(`  - 화면에 보이는 프로그램(시스템 구성요소 제외): ${visible.length}개`)
console.log(`  - 시스템 구성요소(기본으로 숨김): ${all.length - visible.length}개`)

const bySafety = { safe: 0, caution: 0, protected: 0, unknown: 0 }
for (const p of visible) bySafety[p.match.safety]++
console.log(
  `  - 규칙 적용(보이는 것 기준): 안전 ${bySafety.safe} / 주의 ${bySafety.caution} / 보호 ${bySafety.protected} / 규칙 없음 ${bySafety.unknown}`
)
const sources = { registry: 0, scan: 0, unknown: 0 }
for (const p of visible) sources[p.sizeSource]++
console.log(
  `  - 용량 출처: 레지스트리 ${sources.registry} / 스캔 결과 ${sources.scan} / 모름 ${sources.unknown}`
)

// 큰 프로그램: 레지스트리 용량과 설치 폴더 스캔 용량 중 큰 쪽 기준
const rows = visible.map((p) => {
  const node = p.installLocation && index ? findNodeByPath(index, p.installLocation) : null
  const scanned = node?.size
  const registry = p.sizeSource === 'registry' ? p.estimatedSizeBytes : undefined
  return { p, registry, scanned, best: Math.max(registry ?? 0, scanned ?? 0) }
})
rows.sort((a, b) => b.best - a.best)
console.log(`\n=== 큰 프로그램 상위 ${top} (보이는 프로그램 기준) ===`)
rows.slice(0, top).forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(2)}. ${fmt(r.best || undefined).padStart(10)}  ${r.p.name}${r.p.version ? ` ${r.p.version}` : ''}` +
      `  [레지스트리 ${fmt(r.registry)} / 스캔 ${fmt(r.scanned)}]  ${r.p.publisher ?? ''}`
  )
})
const noSize = visible.filter((p) => p.estimatedSizeBytes === undefined).length
console.log(
  `\n용량을 알 수 없는 프로그램: ${noSize}개 (레지스트리에 용량이 없고 설치 폴더도 스캔 결과에 없음)`
)

if (out) {
  const lines = [...all]
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .map(
      (p) =>
        `${p.isSystemComponent ? '[시스템] ' : ''}${p.name}\t${p.version ?? ''}\t${p.publisher ?? ''}\t${fmt(p.estimatedSizeBytes)}\t${p.installLocation ?? ''}`
    )
  writeFileSync(out, lines.join('\n') + '\n', 'utf8')
  console.log(`전체 목록 저장: ${out}`)
}
