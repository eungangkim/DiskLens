// deleteTarget: 삭제의 단일 관문 (SAFETY.md §12). 판정(guard) → 대상 재확인 → 삭제 순서로만 동작한다.
// 판정에 실패하면 어떤 삭제 함수도 호출하지 않는다. 휴지통 이동이 실패해도 영구 삭제로 바꾸지 않는다 (SAFETY.md §8).
import type { DenyReason, SkipReason } from '../../shared/cleanup.ts'
import type { DeleteGuard, DeleteRequest } from '../safety/deleteGuard.ts'
import { errorCode, type FsReader } from '../safety/fsReader.ts'
import type { RemovePort } from './fsPort.ts'

export type TargetKind = 'file' | 'dir'

export interface RemoveRequest extends DeleteRequest {
  kind: TargetKind
}

export type RemoveOutcome =
  | { ok: true }
  | { ok: false; skip: SkipReason; reason: DenyReason | 'io-error' | 'not-empty'; detail: string }

/** 오류 코드 → 건너뜀 이유 (SAFETY.md §8: 사용 중인 파일은 건너뛰고 집계, 강제 해제 금지) */
export function skipReasonForError(code: string | undefined): SkipReason {
  if (code === 'EBUSY') return 'in-use'
  if (code === 'EPERM' || code === 'EACCES') return 'permission-denied'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found'
  return 'other'
}

function skipReasonForDeny(reason: DenyReason): SkipReason {
  if (reason === 'not-found') return 'not-found'
  if (reason === 'link') return 'link'
  return 'safety-denied'
}

export class Remover {
  readonly #guard: DeleteGuard
  readonly #port: RemovePort
  readonly #fs: FsReader

  constructor(guard: DeleteGuard, port: RemovePort, fs: FsReader) {
    this.#guard = guard
    this.#port = port
    this.#fs = fs
  }

  async deleteTarget(request: RemoveRequest): Promise<RemoveOutcome> {
    const verdict = await this.#guard.check(request)
    if (!verdict.allowed) {
      return {
        ok: false,
        skip: skipReasonForDeny(verdict.reason),
        reason: verdict.reason,
        detail: verdict.detail
      }
    }
    const path = verdict.realPath

    // 판정 직후 한 번 더 확인: 종류가 계획과 같은 일반 파일/폴더이고 링크가 아니어야 한다
    try {
      const stat = await this.#fs.lstat(path)
      if (stat.isSymbolicLink) {
        return { ok: false, skip: 'link', reason: 'link', detail: '링크로 바뀌었습니다.' }
      }
      const kindOk = request.kind === 'file' ? stat.isFile : stat.isDirectory
      if (!kindOk) {
        return {
          ok: false,
          skip: 'other',
          reason: 'io-error',
          detail: '대상의 종류가 달라졌습니다.'
        }
      }
      if (request.kind === 'dir' && (await this.#fs.readdir(path)).length > 0) {
        return {
          ok: false,
          skip: 'other',
          reason: 'not-empty',
          detail: '폴더에 남은 항목이 있어 유지합니다.'
        }
      }
    } catch (error) {
      const code = errorCode(error)
      return {
        ok: false,
        skip: skipReasonForError(code),
        reason: 'io-error',
        detail: code ?? '확인 실패'
      }
    }

    try {
      if (request.mode === 'trash') await this.#port.moveToTrash(path)
      else if (request.kind === 'file') await this.#port.deleteFile(path)
      else await this.#port.deleteEmptyDir(path)
      return { ok: true }
    } catch (error) {
      const code = errorCode(error)
      return {
        ok: false,
        skip: skipReasonForError(code),
        reason: 'io-error',
        detail: code ?? (error instanceof Error ? error.message : '삭제 실패')
      }
    }
  }
}
