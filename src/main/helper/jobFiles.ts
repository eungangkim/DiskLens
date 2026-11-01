// main ↔ 헬퍼가 주고받는 파일 (모두 <userData>/elevated/ 안, 이름 고정). 경로를 담지 않는다.
// - job.json    : main 이 쓴다 (항목 ID + 모드 + 토큰 해시 + 서명)
// - result.json : 헬퍼가 쓴다 (항목별 결과). jobId 가 맞아야 main 이 받아들인다
// - cancel.json : main 이 쓴다 ({ jobId }). 헬퍼가 파일 사이에서 확인한다
// 파일을 지우지 않는다: 항상 임시 파일에 쓰고 이름을 바꿔 덮어쓰며, 이전 실행의 파일은 jobId 불일치로 무시한다.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const ELEVATED_DIR_NAME = 'elevated'
export const JOB_FILE = 'job.json'
export const RESULT_FILE = 'result.json'
export const CANCEL_FILE = 'cancel.json'
export const RESULT_SCHEMA_VERSION = 1

const count = z.number().int().nonnegative()

export const helperResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
      jobId: z.string(),
      ok: z.literal(true),
      cancelled: z.boolean(),
      error: z.string().optional(),
      perItem: z.array(
        z
          .object({
            itemId: z.string(),
            freedBytes: count,
            deletedFiles: count,
            skipped: z.array(
              z
                .object({
                  reason: z.enum([
                    'in-use',
                    'permission-denied',
                    'safety-denied',
                    'not-found',
                    'admin-declined',
                    'link',
                    'other'
                  ]),
                  count
                })
                .strict()
            )
          })
          .strict()
      )
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
      jobId: z.string(),
      ok: z.literal(false),
      reason: z.string(),
      error: z.string()
    })
    .strict()
])

export type HelperResult = z.infer<typeof helperResultSchema>

/** 임시 파일에 쓰고 이름을 바꿔 덮어쓴다 (삭제 API 를 쓰지 않는다) */
export async function writeJsonAtomic(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `${name}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' })
  await rename(tmp, join(dir, name))
}

export async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}
