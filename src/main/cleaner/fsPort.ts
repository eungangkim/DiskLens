// 실제 삭제 API 를 호출하는 유일한 파일이다 (테스트 `deletionIsolation` 이 src 전체에서 이를 검사한다).
// 여기의 함수는 판정(safety/deleteGuard.ts)을 하지 않는다: 반드시 cleaner/remover.ts 의 deleteTarget 을 통해서만 호출한다.
// 휴지통 이동(trash)은 Electron 의존성이라 주입받는다 (7단계 연결 시 `shell.trashItem` 을 넘긴다). 기본값이 없다.
import { rmdir, unlink } from 'node:fs/promises'

export interface RemovePort {
  /** 파일 하나를 영구 삭제 (폴더/링크 아님) */
  deleteFile(path: string): Promise<void>
  /** 비어 있는 폴더 하나를 영구 삭제 (내용이 있으면 실패한다) */
  deleteEmptyDir(path: string): Promise<void>
  /** 휴지통으로 이동. 실패해도 영구 삭제로 바꾸지 않는다 */
  moveToTrash(path: string): Promise<void>
}

export function createNodeRemovePort(trash: (path: string) => Promise<void>): RemovePort {
  return {
    deleteFile: (path) => unlink(path),
    deleteEmptyDir: (path) => rmdir(path),
    moveToTrash: (path) => trash(path)
  }
}
