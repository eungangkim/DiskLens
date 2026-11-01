// 삭제 테스트 전용 샌드박스 (SAFETY.md §11, TEST_PLAN.md §4.4).
// - os.tmpdir() 아래의 고유 폴더 하나를 "가짜 C 드라이브"로 만들고, 규칙/보호 경로의 환경변수(env)를 그 안으로 향하게 한다.
//   그래서 `%WINDIR%` → `<샌드박스>\Windows`, `%LOCALAPPDATA%` → `<샌드박스>\Users\tester\AppData\Local` 이 된다.
//   보호 경로 검사는 꺼지지 않는다: 같은 하드코딩 목록이 가짜 드라이브 기준으로 그대로 동작한다.
// - 이 파일의 정리 함수(dispose)는 샌드박스 루트가 tmpdir 아래의 우리 폴더일 때만 지운다.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { PathRule } from '../../src/shared/rules.ts'
import { buildRuleSet, type LoadedRuleSet } from '../../src/main/rules/loader.ts'

// tmpdir 이 8.3 짧은 이름(예: LONGUS~1)일 수 있어 실제 경로로 바꿔 둔다 (realpath 비교가 어긋나지 않게)
const BASE = join(realpathSync.native(tmpdir()), 'disklens-delete-test')

export interface Sandbox {
  /** 가짜 C 드라이브 루트 (예: C:\Users\...\Temp\disklens-delete-test\ab12cd) */
  root: string
  env: Record<string, string>
  /** 루트 기준 경로를 절대 경로로 */
  p(...rel: string[]): string
  /** 파일 만들기 (상위 폴더 자동 생성). ageDays 만큼 오래된 파일로 만든다 */
  write(rel: string, content?: string, ageDays?: number): string
  mkdir(rel: string): string
  /** 폴더 정션(없으면 심볼릭 링크)을 만든다. 만들 수 없는 환경이면 false */
  link(rel: string, targetRel: string): boolean
  exists(rel: string): boolean
  /** 샌드박스 안의 폴더/파일을 치운다 (테스트 시나리오에서 "계획 이후 바꿔치기"를 만들 때 쓴다) */
  remove(rel: string): void
  ruleSet(rules: PathRule[]): LoadedRuleSet
  dispose(): void
}

/** 지우려는 경로가 우리가 만든 샌드박스 안인지 확인한다 (실수로 다른 곳을 지우지 않도록) */
function assertOurSandbox(root: string): void {
  const full = resolve(root)
  const base = resolve(BASE) + sep
  if (!full.startsWith(base) || full.length <= base.length) {
    throw new Error(`샌드박스가 아닌 경로입니다: ${root}`)
  }
}

export function createSandbox(): Sandbox {
  mkdirSync(BASE, { recursive: true })
  const root = mkdtempSync(join(BASE, `${randomBytes(2).toString('hex')}-`))
  assertOurSandbox(root)
  const env: Record<string, string> = {
    SYSTEMDRIVE: root,
    WINDIR: join(root, 'Windows'),
    USERPROFILE: join(root, 'Users', 'tester'),
    LOCALAPPDATA: join(root, 'Users', 'tester', 'AppData', 'Local'),
    APPDATA: join(root, 'Users', 'tester', 'AppData', 'Roaming'),
    PROGRAMDATA: join(root, 'ProgramData'),
    PROGRAMFILES: join(root, 'Program Files'),
    'PROGRAMFILES(X86)': join(root, 'Program Files (x86)')
  }
  const p = (...rel: string[]): string => join(root, ...rel)

  const sandbox: Sandbox = {
    root,
    env,
    p,
    mkdir(rel) {
      mkdirSync(p(rel), { recursive: true })
      return p(rel)
    },
    write(rel, content = 'x', ageDays = 0) {
      const full = p(rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      if (ageDays > 0) {
        const t = new Date(Date.now() - ageDays * 86_400_000)
        utimesSync(full, t, t)
      }
      return full
    },
    link(rel, targetRel) {
      try {
        mkdirSync(dirname(p(rel)), { recursive: true })
        symlinkSync(p(targetRel), p(rel), 'junction')
        return true
      } catch {
        return false
      }
    },
    exists: (rel) => existsSync(p(rel)),
    remove(rel) {
      const target = resolve(p(rel))
      if (!target.startsWith(resolve(root) + sep))
        throw new Error(`샌드박스 밖의 경로입니다: ${rel}`)
      rmSync(target, { recursive: true, force: true })
    },
    ruleSet(rules) {
      return buildRuleSet(
        { builtin: { schemaVersion: 1, rulesVersion: 'test', pathRules: rules, programRules: [] } },
        { env }
      )
    },
    dispose() {
      assertOurSandbox(root)
      rmSync(root, { recursive: true, force: true })
    }
  }
  return sandbox
}
