// 프로그램 관련 IPC 입력 검증 스키마 (electron 에 의존하지 않아 단위 테스트에서 그대로 불러올 수 있다)
import { z } from 'zod'

export const programsListSchema = z
  .object({ includeSystem: z.boolean(), refresh: z.boolean() })
  .strict()
export const programIdSchema = z.object({ programId: z.string().min(1).max(100) }).strict()
/** 제거 실행 요청: 명령줄이나 경로 필드는 받지 않는다 (알 수 없는 필드는 거부) */
export const uninstallSchema = z
  .object({
    programId: z.string().min(1).max(100),
    confirmationId: z.string().min(1).max(200),
    acknowledgeCaution: z.boolean()
  })
  .strict()
