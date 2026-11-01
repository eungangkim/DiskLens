// 읽기 전용 파일 시스템 접근 포트. 판정부(guard)와 대상 열거가 쓴다. 삭제 함수는 여기에 없다 (cleaner/fsPort.ts 에만 있다).
// 테스트에서 가짜 구현(예: 8.3 짧은 이름 해석)을 주입할 수 있게 인터페이스로 둔다.
import { realpath as realpathCallback } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'

// Windows 의 8.3 짧은 이름까지 풀어 주는 네이티브 realpath
const realpathNative = promisify(realpathCallback.native)

export interface FileStat {
  isFile: boolean
  isDirectory: boolean
  /** 심볼릭 링크 또는 정션 (Node 는 정션도 심볼릭 링크로 보고한다) */
  isSymbolicLink: boolean
  size: number
  mtimeMs: number
}

export interface FsReader {
  lstat(path: string): Promise<FileStat>
  /** 링크와 8.3 짧은 이름을 모두 해석한 실제 경로 */
  realpath(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
}

export const nodeFsReader: FsReader = {
  async lstat(path) {
    const s = await lstat(path)
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs
    }
  },
  realpath: (path) => realpathNative(path),
  readdir: (path) => readdir(path)
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
