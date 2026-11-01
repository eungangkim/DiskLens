// "실제 시스템 경로에 대한 삭제 호출이 코드·테스트 어디에도 없음"을 기계적으로 확인하는 정적 검사 (ROADMAP 6단계 완료 기준).
// 1) src 에서 파일 삭제 API 는 cleaner/fsPort.ts 한 곳에서만 호출한다.
// 2) fsPort 의 삭제 함수는 cleaner/remover.ts(= safety 관문 뒤)에서만 호출한다.
// 3) 테스트 코드는 샌드박스 도우미(tests/fixtures/deleteSandbox.ts) 밖에서 파일 삭제 API 를 호출하지 않는다.
// 4) 샌드박스 루트는 항상 os.tmpdir() 아래다.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandbox } from '../fixtures/deleteSandbox.ts'

const ROOT = process.cwd()

function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (name === 'node_modules' || name === 'out' || name.startsWith('.')) continue
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** 주석을 지운 코드 (주석 속 설명 때문에 오탐하지 않도록) */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join('/')

// 파일/폴더 삭제 API 호출 (fs.rm, rmSync, unlink, rmdir, trashItem, rimraf 등)
const DELETE_CALL =
  /\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|trashItem|rimraf|emptyDir|removeSync)\s*\(/
// fsPort 의 삭제 함수 호출
const PORT_CALL = /\b(deleteFile|deleteEmptyDir|moveToTrash)\s*\(/

describe('삭제 코드 격리 (정적 검사)', () => {
  const src = sourceFiles(join(ROOT, 'src'), ['.ts', '.tsx'])
  const scripts = sourceFiles(join(ROOT, 'scripts'), ['.ts'])

  it('src 와 scripts 에서 파일 삭제 API 호출은 cleaner/fsPort.ts 한 곳뿐이다', () => {
    // 예외: main/index.ts 는 휴지통 함수(shell.trashItem)를 엔진에 "주입"만 한다 (아래 테스트가 그 한 줄만 허용)
    const offenders = [...src, ...scripts].filter((f) => DELETE_CALL.test(code(f))).map(rel)
    expect(offenders).toEqual(['src/main/cleaner/fsPort.ts', 'src/main/index.ts'])
  })

  it('main/index.ts 의 삭제 관련 호출은 shell.trashItem 주입 한 곳뿐이다', () => {
    const matches = code(join(ROOT, 'src/main/index.ts')).match(new RegExp(DELETE_CALL, 'g')) ?? []
    expect(matches.map((m) => m.replace(/\s/g, ''))).toEqual(['trashItem('])
    expect(code(join(ROOT, 'src/main/index.ts'))).toMatch(
      /createCleanupEngine\(\{[\s\S]*trash,[\s\S]*\}\)/
    )
  })

  it('fsPort 의 삭제 함수는 remover.ts 에서만 호출한다 (판정 관문 뒤)', () => {
    const callers = src
      .filter((f) => !rel(f).endsWith('cleaner/fsPort.ts'))
      .filter((f) => PORT_CALL.test(code(f)))
      .map(rel)
    expect(callers).toEqual(['src/main/cleaner/remover.ts'])
  })

  it('remover.ts 는 삭제 전에 반드시 guard.check 를 호출한다', () => {
    const text = code(join(ROOT, 'src/main/cleaner/remover.ts'))
    const checkAt = text.indexOf('this.#guard.check(')
    const firstPortCall = text.search(PORT_CALL)
    expect(checkAt).toBeGreaterThan(-1)
    expect(firstPortCall).toBeGreaterThan(checkAt)
  })

  it('fsPort 를 가져다 쓰는 곳은 remover(타입)와 엔진 조립(cleaner/engine.ts)뿐이다', () => {
    const importers = src
      .filter((f) => /from '[^']*cleaner\/fsPort\.ts'|from '\.\/fsPort\.ts'/.test(code(f)))
      .map(rel)
      .sort()
    expect(importers).toEqual(['src/main/cleaner/engine.ts', 'src/main/cleaner/remover.ts'])
  })

  it('테스트 코드는 샌드박스 도우미 밖에서 삭제 API 를 호출하지 않는다', () => {
    const tests = sourceFiles(join(ROOT, 'tests'), ['.ts'])
    const offenders = tests
      .filter((f) => !rel(f).endsWith('tests/unit/deletionIsolation.test.ts'))
      .filter((f) => DELETE_CALL.test(code(f)))
      .map(rel)
    expect(offenders).toEqual(['tests/fixtures/deleteSandbox.ts'])
  })

  it('샌드박스 도우미의 삭제는 우리 샌드박스 경로 검사(assertOurSandbox) 뒤에서만 일어난다', () => {
    const text = code(join(ROOT, 'tests/fixtures/deleteSandbox.ts'))
    expect(text).toContain('assertOurSandbox(root)')
    expect(text).toMatch(/startsWith\(resolve\(root\) \+ sep\)/)
  })
})

describe('샌드박스', () => {
  it('항상 os.tmpdir() 아래의 고유 폴더이고, 가짜 드라이브 env 도 그 안을 가리킨다', () => {
    const sb = createSandbox()
    try {
      const tmp = realpathSync.native(tmpdir()).toLowerCase()
      expect(sb.root.toLowerCase().startsWith(tmp + sep)).toBe(true)
      for (const value of Object.values(sb.env)) {
        expect(value.toLowerCase().startsWith(sb.root.toLowerCase())).toBe(true)
      }
      expect(sb.root.toLowerCase()).not.toBe('c:\\')
    } finally {
      sb.dispose()
    }
  })

  it('샌드박스 밖 경로는 치우기를 거부한다', () => {
    const sb = createSandbox()
    try {
      expect(() => sb.remove('..\\..\\outside')).toThrow()
    } finally {
      sb.dispose()
    }
  })
})
