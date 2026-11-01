// 관리자 헬퍼 job 파일 (ARCHITECTURE.md §7.2). 파일에는 "항목 ID 목록 + 모드 + 토큰 해시 + 서명"만 담는다.
// 경로를 담는 필드는 없다: 알 수 없는 필드(path, paths, targets …)가 하나라도 있으면 파일 전체를 거부한다 (strict).
//
// 신뢰 모델(정직하게):
// - job 파일은 사용자 쓰기 가능 폴더에 있다. 그래서 서명(HMAC)으로 변조를 걸러내지만, 서명 키(token)는 헬퍼 실행 인자로
//   전달되므로 "같은 사용자 권한의 악성 프로그램"까지 막는 장치는 아니다.
// - 진짜 한계선은 두 가지다: ① UAC 동의 창(사용자 확인), ② 헬퍼의 하드코딩 허용 목록(adminRules.ts) —
//   서명이 맞아도 허용 목록 밖의 항목 ID 는 거부하고, 허용 항목도 보호 경로 검사를 헬퍼가 다시 한다.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ADMIN_ITEMS, isAdminItemId } from './adminRules.ts'

export const JOB_SCHEMA_VERSION = 1
/** job 의 유효 시간. 만료된 job 은 거부한다 (재사용 방지) */
export const JOB_TTL_MS = 2 * 60_000
export const MAX_JOB_BYTES = 8 * 1024
const MAX_ITEMS = 8
const CLOCK_SKEW_MS = 30_000

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)

export const jobSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    jobId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    itemIds: z
      .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/))
      .min(1)
      .max(MAX_ITEMS),
    mode: z.enum(['trash', 'permanent']),
    /** 주의(caution) 항목 경고를 사용자가 확인했는지 (main 의 확인 단계 결과) */
    acknowledgeCaution: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** sha256(token) */
    tokenHash: hex64,
    /** HMAC-SHA256(key = token, 위 필드의 정식 문자열) */
    mac: hex64
  })
  .strict()

export type Job = z.infer<typeof jobSchema>
export type UnsignedJob = Omit<Job, 'mac'>

export type JobRejectReason =
  | 'unreadable' // 읽을 수 없음 / 없음
  | 'too-large' // 크기 제한 초과
  | 'not-regular-file' // 일반 파일이 아님 (링크 등)
  | 'malformed' // JSON/스키마 오류
  | 'extra-fields' // 알 수 없는 필드 (경로 직접 지정 등)
  | 'bad-token' // 토큰 해시 불일치
  | 'bad-signature' // 서명 불일치 (변조)
  | 'expired' // 유효 시간 지남
  | 'not-yet-valid' // 시각이 미래
  | 'item-not-allowed' // 허용 목록 밖 항목 ID
  | 'duplicate-items' // 항목 ID 중복
  | 'caution-not-acknowledged' // 주의 항목인데 경고 확인 없음

export type JobCheck = { ok: true; job: Job } | { ok: false; reason: JobRejectReason }

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 서명 대상 정식 문자열: 항목 ID 는 정렬해 순서가 달라도 같은 문자열이 된다 */
export function canonicalJob(job: UnsignedJob): string {
  const ids = [...job.itemIds].sort().join(',')
  return [
    `v${job.schemaVersion}`,
    job.jobId,
    job.mode,
    job.acknowledgeCaution ? '1' : '0',
    job.createdAt,
    job.expiresAt,
    job.tokenHash,
    ids
  ].join('|')
}

export function signJob(job: UnsignedJob, token: string): string {
  return createHmac('sha256', token).update(canonicalJob(job)).digest('hex')
}

/** 새 job 을 만든다 (main 쪽). token 은 호출자가 만들어 헬퍼 실행 인자로 따로 전달한다 */
export function createJob(input: {
  jobId: string
  itemIds: readonly string[]
  mode: 'trash' | 'permanent'
  acknowledgeCaution: boolean
  token: string
  now: number
}): Job {
  const unsigned: UnsignedJob = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: input.jobId,
    itemIds: [...input.itemIds],
    mode: input.mode,
    acknowledgeCaution: input.acknowledgeCaution,
    createdAt: input.now,
    expiresAt: input.now + JOB_TTL_MS,
    tokenHash: sha256Hex(input.token)
  }
  return { ...unsigned, mac: signJob(unsigned, input.token) }
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/**
 * 읽어 온 JSON 을 검증한다. 순서: 구조(strict) → 토큰 해시 → 서명 → 시간 → 허용 목록.
 * 어느 하나라도 틀리면 거부한다. 허용 목록 검사는 서명이 맞아도 항상 한다.
 */
export function verifyJob(raw: unknown, token: string, now: number): JobCheck {
  const parsed = jobSchema.safeParse(raw)
  if (!parsed.success) {
    const extra = parsed.error.issues.some((i) => i.code === 'unrecognized_keys')
    return { ok: false, reason: extra ? 'extra-fields' : 'malformed' }
  }
  const job = parsed.data
  if (!safeEqualHex(sha256Hex(token), job.tokenHash)) return { ok: false, reason: 'bad-token' }
  const { mac, ...unsigned } = job
  if (!safeEqualHex(signJob(unsigned, token), mac)) return { ok: false, reason: 'bad-signature' }
  if (job.createdAt > now + CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' }
  if (now >= job.expiresAt || job.expiresAt - job.createdAt > JOB_TTL_MS) {
    return { ok: false, reason: 'expired' }
  }
  if (new Set(job.itemIds).size !== job.itemIds.length) {
    return { ok: false, reason: 'duplicate-items' }
  }
  if (!job.itemIds.every(isAdminItemId)) return { ok: false, reason: 'item-not-allowed' }
  const needsAck = job.itemIds.some(
    (id) => ADMIN_ITEMS.find((i) => i.id === id)?.safety === 'caution'
  )
  if (needsAck && !job.acknowledgeCaution) return { ok: false, reason: 'caution-not-acknowledged' }
  return { ok: true, job }
}
