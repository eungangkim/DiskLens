// 정리/설정 IPC 입력 검증 스키마 (순수 zod). electron 에 의존하지 않아 단위 테스트에서 바로 쓴다.
// renderer 는 경로가 아니라 항목 ID 와 확인 토큰만 보낸다. 알 수 없는 필드(경로 등)는 거부한다 (strict).
import { z } from 'zod'

const idSchema = z.string().min(1).max(100)

export const cleanupAnalyzeSchema = z.object({ itemId: idSchema }).strict()
export const cleanupPlanSchema = z
  .object({
    itemIds: z.array(idSchema).min(1).max(200),
    mode: z.enum(['trash', 'permanent'])
  })
  .strict()
export const cleanupExecuteSchema = z
  .object({
    planId: idSchema,
    confirmationId: z.string().min(1).max(200),
    acknowledgeCaution: z.boolean()
  })
  .strict()
export const cleanupCancelSchema = z.object({ jobId: idSchema }).strict()
export const settingsSetSchema = z
  .object({
    allowPermanentDelete: z.boolean(),
    sizeUnit: z.enum(['GiB', 'GB']),
    theme: z.enum(['system', 'light', 'dark']),
    scanRoot: z.string().min(1).max(260).nullable(),
    excludePaths: z.array(z.string().min(1).max(260)).max(50)
  })
  .strict()
export const pickFolderSchema = z.object({ purpose: z.enum(['scanRoot', 'exclude']) }).strict()
export const openFolderSchema = z.object({ target: z.enum(['logs', 'userData']) }).strict()
export const noArgsSchema = z.undefined()
