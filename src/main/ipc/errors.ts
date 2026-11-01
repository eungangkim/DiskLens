import { z } from 'zod'
import type { IpcErrorCode, IpcResult } from '../../shared/ipc.ts'

/** 서비스가 구조화된 오류 코드로 던지는 에러 (ARCHITECTURE.md §6, §11) */
export class AppError extends Error {
  code: IpcErrorCode
  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * 입력 검증 → 서비스 호출 → 결과 변환. 실패는 예외 대신 { ok:false, code } 로 돌려준다.
 * 검증에 실패하면 서비스 함수는 호출되지 않는다.
 */
export function wrapHandler<S extends z.ZodType, R>(
  schema: S,
  fn: (input: z.infer<S>) => R | Promise<R>,
  log?: (message: string, error?: unknown) => void
): (raw: unknown) => Promise<IpcResult<R>> {
  return async (raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.' }
    }
    try {
      return { ok: true, data: await fn(parsed.data) }
    } catch (error) {
      if (error instanceof AppError) return { ok: false, code: error.code, message: error.message }
      log?.('IPC 처리 중 예기치 않은 오류', error)
      return { ok: false, code: 'INTERNAL', message: '내부 오류가 발생했습니다.' }
    }
  }
}
