// 모의 제거 프로그램 (TEST_PLAN.md §4.6, ROADMAP 9단계). 실제로 설치된 프로그램의 제거 명령은 어떤 테스트에서도 실행하지 않는다.
// "제거 프로그램" 역할은 node.exe + 이 스크립트가 한다: 인자에 따라 종료 코드를 정하고, 흔적 파일을 남기고, 가짜 레지스트리에서 항목을 빼 준다.
// 스크립트는 샌드박스 안에만 쓴다. 파일을 지우지 않는다 (가짜 레지스트리는 "다시 쓰기"로 항목을 뺀다).
import { writeFileSync } from 'node:fs'
import type { RawUninstallEntry } from '../../src/main/programs/registry.ts'
import type { Sandbox } from './deleteSandbox.ts'

/** 모의 제거 프로그램 스크립트 본문. 인자: --exit N --marker 파일 --registry 파일 --key 키 --sleep ms --args-out 파일 */
export const MOCK_UNINSTALL_SCRIPT = `
const fs = require('node:fs')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const code = Number(opt('--exit') ?? '0')
const marker = opt('--marker')
const registry = opt('--registry')
const key = opt('--key')
const sleep = Number(opt('--sleep') ?? '0')
const argsOut = opt('--args-out')
if (argsOut) fs.writeFileSync(argsOut, JSON.stringify(argv))
setTimeout(() => {
  if (marker) fs.writeFileSync(marker, 'ran')
  // 성공 코드일 때만 "레지스트리에서 항목 제거"를 흉내 낸다 (파일 삭제 API 없이 다시 쓰기)
  if (registry && key && (code === 0 || code === 3010)) {
    const entries = JSON.parse(fs.readFileSync(registry, 'utf8'))
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => e.key !== key)))
  }
  process.exit(code)
}, sleep)
`

/** 가짜 레지스트리 항목 하나 (RawUninstallEntry) */
export function fakeEntry(
  key: string,
  values: Record<string, unknown>,
  scope: RawUninstallEntry['scope'] = 'machine'
): RawUninstallEntry {
  return { scope, key, values }
}

export interface MockInstall {
  /** 모의 제거 프로그램 스크립트의 경로 */
  script: string
  /** 가짜 레지스트리 JSON 의 경로 */
  registry: string
  marker: string
  argsOut: string
  /** 레지스트리 UninstallString 로 넣을 문자열을 만든다 */
  uninstallString(extra?: string): string
  writeRegistry(entries: RawUninstallEntry[]): void
}

/** 샌드박스 안에 모의 제거 프로그램과 가짜 레지스트리를 만든다. node.exe 경로는 따옴표로 묶는다 (공백 경로 대비) */
export function createMockInstall(sb: Sandbox, key: string): MockInstall {
  const script = sb.p('mock', 'mock-uninstall.js')
  sb.write('mock/mock-uninstall.js', MOCK_UNINSTALL_SCRIPT)
  const registry = sb.p('fake-registry.json')
  const marker = sb.p('mock', `${key}.ran`)
  const argsOut = sb.p('mock', `${key}.args.json`)
  return {
    script,
    registry,
    marker,
    argsOut,
    uninstallString: (extra = '') =>
      `"${process.execPath}" "${script}" --marker "${marker}" --registry "${registry}" --key ${key} --args-out "${argsOut}" ${extra}`.trim(),
    writeRegistry: (entries) => writeFileSync(registry, JSON.stringify(entries))
  }
}
