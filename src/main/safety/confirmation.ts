// 확인 토큰 (SAFETY.md §4 "확인 단계", ARCHITECTURE.md §7.1).
// - 일회용: 한 번 쓰면 다시 쓸 수 없다.
// - 짧은 TTL: 만료되면 거부한다.
// - 계획 바인딩: 토큰은 발급된 계획(planId)과 그 계획 내용 해시(digest)에 묶여 있고, 다른 계획이나 바뀐 계획에는 쓸 수 없다.
// 소비에 성공하면 ExecutionPermit 을 돌려준다. 삭제 관문은 이 permit 이 없으면 아무것도 지우지 않는다.
import { createHash, randomBytes } from 'node:crypto'
import type { CleanupMode } from '../../shared/cleanup.ts'

const issuedPermits = new WeakSet<object>()
const PERMIT_BRAND = Symbol('execution-permit')

/** 확인 단계를 통과했다는 증표. 이 파일의 ConfirmationStore 만 만들 수 있다 (구조만 흉내 낸 객체는 거부된다) */
export class ExecutionPermit {
  readonly planId: string
  readonly mode: CleanupMode
  readonly itemIds: ReadonlySet<string>
  readonly acknowledgeCaution: boolean

  /** @internal ConfirmationStore 전용 */
  constructor(
    brand: typeof PERMIT_BRAND,
    planId: string,
    mode: CleanupMode,
    itemIds: Iterable<string>,
    acknowledgeCaution: boolean
  ) {
    if (brand !== PERMIT_BRAND)
      throw new Error('ExecutionPermit 은 ConfirmationStore 만 만들 수 있습니다.')
    this.planId = planId
    this.mode = mode
    this.itemIds = new Set(itemIds)
    this.acknowledgeCaution = acknowledgeCaution
    issuedPermits.add(this)
  }
}

export function isIssuedPermit(value: unknown): value is ExecutionPermit {
  return typeof value === 'object' && value !== null && issuedPermits.has(value)
}

/** 계획 내용 해시: 항목 ID(정렬), 모드, 항목별 대상 수/용량. 계획이 바뀌면 해시도 바뀐다 */
export function planDigest(plan: {
  planId: string
  mode: CleanupMode
  items: ReadonlyArray<{ itemId: string; fileCount: number; bytes: number }>
}): string {
  const items = [...plan.items]
    .sort((a, b) => a.itemId.localeCompare(b.itemId))
    .map((i) => `${i.itemId}:${i.fileCount}:${i.bytes}`)
  return createHash('sha256')
    .update(`${plan.planId}|${plan.mode}|${items.join(',')}`)
    .digest('hex')
}

export type ConsumeFailure =
  | 'unknown' // 발급한 적 없는 토큰
  | 'used' // 이미 사용됨
  | 'expired' // TTL 지남
  | 'plan-mismatch' // 다른 계획의 토큰
  | 'plan-changed' // 계획 내용이 발급 때와 다름
  | 'caution-not-acknowledged' // caution 항목이 있는데 경고 확인이 없음

export type ConsumeResult =
  { ok: true; permit: ExecutionPermit } | { ok: false; reason: ConsumeFailure }

interface Entry {
  planId: string
  digest: string
  expiresAt: number
  used: boolean
}

export interface ConfirmationOptions {
  /** 기본 5분 */
  ttlMs?: number
  now?: () => number
  /** 토큰 생성기 (테스트용 주입). 기본은 암호학적 난수 */
  randomToken?: () => string
}

export class ConfirmationStore {
  readonly #entries = new Map<string, Entry>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #randomToken: () => string

  constructor(options: ConfirmationOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 5 * 60_000
    this.#now = options.now ?? Date.now
    this.#randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'))
  }

  /** 토큰 원문은 호출자에게만 돌려주고, 저장은 해시로 한다 */
  issue(plan: { planId: string; digest: string }): { confirmationId: string; expiresAt: number } {
    this.#purge()
    const confirmationId = this.#randomToken()
    const expiresAt = this.#now() + this.#ttlMs
    this.#entries.set(hashToken(confirmationId), {
      planId: plan.planId,
      digest: plan.digest,
      expiresAt,
      used: false
    })
    return { confirmationId, expiresAt }
  }

  /**
   * 토큰을 검증하고 소비한다. 실패하면 이유를 돌려준다.
   * 계획이 다르거나 내용이 바뀐 경우, 경고 확인이 빠진 경우에는 토큰을 소비하지 않는다(올바른 요청이 다시 가능).
   * 만료·이미 사용·성공은 소비(또는 이미 소비) 상태다.
   */
  consume(request: {
    planId: string
    confirmationId: string
    digest: string
    mode: CleanupMode
    itemIds: Iterable<string>
    needsCautionAck: boolean
    acknowledgeCaution: boolean
  }): ConsumeResult {
    const entry = this.#entries.get(hashToken(request.confirmationId))
    if (!entry) return { ok: false, reason: 'unknown' }
    if (entry.used) return { ok: false, reason: 'used' }
    if (this.#now() >= entry.expiresAt) {
      entry.used = true
      return { ok: false, reason: 'expired' }
    }
    if (entry.planId !== request.planId) return { ok: false, reason: 'plan-mismatch' }
    if (entry.digest !== request.digest) return { ok: false, reason: 'plan-changed' }
    if (request.needsCautionAck && !request.acknowledgeCaution) {
      return { ok: false, reason: 'caution-not-acknowledged' }
    }
    entry.used = true
    return {
      ok: true,
      permit: new ExecutionPermit(
        PERMIT_BRAND,
        request.planId,
        request.mode,
        request.itemIds,
        request.acknowledgeCaution
      )
    }
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, entry] of this.#entries) {
      // 만료·사용된 기록은 "used/expired" 로 알려 주기 위해 잠시 남기고, 오래되면 지운다
      if (now >= entry.expiresAt + this.#ttlMs) this.#entries.delete(key)
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
