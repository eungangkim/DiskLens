// 테스트용 가짜 폴더 트리 생성기 (TEST_PLAN.md §3).
// 안전 규칙: 항상 os.tmpdir() 아래에만 만든다. 이 파일은 파일을 "지우는" 코드를 포함하지 않는다.
// 같은 이름으로 다시 호출하면 이미 만들어진 트리를 재사용한다(폴더 이름에 버전을 넣어 구조가 바뀌면 새 폴더가 쓰인다).
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE_VERSION = 'v1'
const MARKER = '.fixture-complete'

export interface FixtureFile {
  /** 트리 루트 기준 상대 경로 (역슬래시/슬래시는 OS 기본) */
  rel: string
  size: number
}

export interface FixtureTree {
  root: string
  /** 링크를 제외한 실제 파일 목록 */
  files: FixtureFile[]
  /** 정션(폴더 링크) 생성에 성공했는지 */
  junctionsCreated: boolean
  /** 정션 경로(루트 기준 상대) */
  junctions: string[]
  /** rel 경로 접두사 아래 파일들의 논리 크기 합 */
  logicalSizeUnder(relPrefix: string): number
  totalLogical(): number
  /** 클러스터 올림 합 */
  totalAllocated(cluster?: number): number
}

const MB = 1024 * 1024

export function createFixtureTree(name: string): FixtureTree {
  const root = join(tmpdir(), 'disklens-test-fixtures', FIXTURE_VERSION, name)
  const files: FixtureFile[] = []
  const complete = existsSync(join(root, MARKER))

  const add = (rel: string, size: number): void => {
    files.push({ rel, size })
    if (complete) return
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, Buffer.alloc(size, 97))
  }

  // 알려진 크기의 파일들
  add(join('docs', 'a.txt'), 1000)
  add(join('docs', 'b.txt'), 2000)
  add(join('media', 'v1.mp4'), 3 * MB)
  add(join('media', 'v2.mp4'), 1 * MB)
  // 많은 작은 파일
  for (let i = 0; i < 2000; i++) add(join('many', `f${String(i).padStart(4, '0')}.bin`), 100)
  // 깊은 중첩(깊이 60)
  const deepDirs = Array.from({ length: 60 }, (_, i) => `d${i}`)
  add(join('deep', ...deepDirs, 'bottom.dat'), 5000)
  // 규칙 매칭 흉내 폴더 (작은 폴더라 접힘 대상이지만 keep 옵션으로 유지되어야 함)
  add(join('Temp', 't1.tmp'), 500)
  add(join('Cache', 'c1.bin'), 700)
  add(join('node_modules', 'pkg', 'index.js'), 300)
  add(join('Library', 'lib.dat'), 400)

  const junctions = [join('docs', 'linkToMedia'), join('media', 'loop')]
  let junctionsCreated: boolean
  if (!complete) {
    mkdirSync(join(root, 'empty'), { recursive: true })
    try {
      symlinkSync(join(root, 'media'), join(root, junctions[0] as string), 'junction')
      symlinkSync(root, join(root, junctions[1] as string), 'junction') // 순환 링크
      junctionsCreated = true
    } catch {
      junctionsCreated = false // 생성 권한이 없으면 링크 테스트는 건너뛴다
    }
    writeFileSync(join(root, MARKER), 'ok')
  } else {
    junctionsCreated = existsSync(join(root, junctions[0] as string))
  }
  files.push({ rel: MARKER, size: 2 }) // 마커 파일도 트리에 포함된다

  return {
    root,
    files,
    junctionsCreated,
    junctions,
    logicalSizeUnder: (prefix) =>
      files
        .filter(
          (f) =>
            f.rel === prefix || f.rel.startsWith(prefix + '\\') || f.rel.startsWith(prefix + '/')
        )
        .reduce((s, f) => s + f.size, 0),
    totalLogical: () => files.reduce((s, f) => s + f.size, 0),
    totalAllocated: (cluster = 4096) =>
      files.reduce((s, f) => s + (f.size === 0 ? 0 : Math.ceil(f.size / cluster) * cluster), 0)
  }
}
