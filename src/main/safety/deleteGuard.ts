// 삭제 관문 (SAFETY.md §3, §4, §12 "단일 관문"). 삭제 코드는 반드시 이 판정을 통과해야 한다.
// 판정은 읽기 전용이다(lstat/realpath). 실제 삭제는 cleaner/remover.ts 가 이 판정 뒤에만 한다.
// 허용 루트는 "규칙 DB 와 보호 경로의 환경(env)"으로 주입된다: 테스트는 임시 폴더를 가짜 드라이브로 하는 env 를 넘기며,
// 보호 검사를 끄는 플래그는 어디에도 없다.
import type { CleanupMode, DenyReason } from '../../shared/cleanup.ts'
import type { LoadedRule, RuleLookup } from '../rules/matcher.ts'
import { normalizeKey } from '../rules/paths.ts'
import { isIssuedPermit, type ExecutionPermit } from './confirmation.ts'
import { errorCode, type FsReader } from './fsReader.ts'
import { isProtectedFileName, type ProtectedPaths } from './protectedPaths.ts'
import { sanitizeRawPath } from './rawPath.ts'

export type GuardVerdict =
  | { allowed: true; ruleId: string; realPath: string }
  | { allowed: false; reason: DenyReason; detail: string }

export interface GuardSettings {
  /** 설정의 "영구 삭제 허용" (기본 false). 요청 시점마다 읽는다 */
  allowPermanentDelete(): boolean
}

export interface GuardDeps {
  protectedPaths: ProtectedPaths
  matcher: RuleLookup
  fs: FsReader
  settings: GuardSettings
}

export interface DeleteRequest {
  /** 지울 대상 경로 (파일 또는 비어 있는 폴더). 항상 main 이 규칙에서 해석한 값이다 */
  path: string
  /** 이 대상이 속한 정리 항목의 규칙. renderer 가 보낸 경로가 아니라 itemId 로 찾은 규칙이다 */
  rule: LoadedRule
  mode: CleanupMode
  /** 확인 단계를 통과해야 만들어지는 증표 */
  permit: ExecutionPermit | undefined
}

const deny = (reason: DenyReason, detail: string): GuardVerdict => ({
  allowed: false,
  reason,
  detail
})

/**
 * 규칙 수준 조건 (경로와 무관). SAFETY.md §4 의 cleanable / safety / caution 확인 / 영구 삭제 조건.
 * 순수 함수라서 계획(plan) 단계에서도 쓴다.
 */
export function judgeRule(
  rule: LoadedRule,
  mode: CleanupMode,
  acknowledgeCaution: boolean,
  allowPermanentDelete: boolean
): GuardVerdict | null {
  const { cleanup } = rule.rule
  if (!rule.rule.cleanable || !cleanup) {
    return deny('not-cleanable', '표시 전용 규칙은 삭제할 수 없습니다.')
  }
  if (rule.rule.safety === 'protected') return deny('protected-rule', '보호(protected) 규칙입니다.')
  if (rule.rule.safety !== 'safe' && rule.rule.safety !== 'caution') {
    return deny('unknown-rule', '안전도를 알 수 없는 규칙입니다.')
  }
  if (cleanup.specialAction) {
    return deny(
      'special-action-only',
      '이 항목은 전용 동작으로만 처리합니다 (파일을 직접 지우지 않음).'
    )
  }
  if (rule.rule.safety === 'caution' && !acknowledgeCaution) {
    return deny('caution-not-acknowledged', '주의(caution) 항목은 경고 확인이 필요합니다.')
  }
  if (mode === 'permanent') {
    const category = rule.rule.category
    if (!cleanup.allowPermanent || (category !== 'temp' && category !== 'cache')) {
      return deny(
        'permanent-not-allowed',
        '이 항목은 영구 삭제가 허용되지 않습니다 (휴지통 이동만 가능).'
      )
    }
    if (!allowPermanentDelete) {
      return deny('permanent-disabled', '설정에서 영구 삭제가 꺼져 있습니다.')
    }
  }
  return null
}

export class DeleteGuard {
  readonly #deps: GuardDeps

  constructor(deps: GuardDeps) {
    this.#deps = deps
  }

  /** 삭제 직전 최종 판정 (permit 포함). 하나라도 실패하면 거부 */
  async check(request: DeleteRequest): Promise<GuardVerdict> {
    const { permit, rule, mode } = request
    if (!isIssuedPermit(permit))
      return deny('no-confirmation', '확인 단계를 거치지 않은 요청입니다.')
    if (permit.mode !== mode) return deny('no-confirmation', '확인한 삭제 방식과 다릅니다.')
    if (!permit.itemIds.has(rule.rule.id)) {
      return deny('no-confirmation', '확인하지 않은 정리 항목입니다.')
    }
    return this.evaluate(request.path, rule, mode, permit.acknowledgeCaution)
  }

  /**
   * 경로 판정 (permit 없이). 계획(plan)의 대상 계산에도 쓴다.
   * 순서: 규칙 조건 → 문자열 검증 → 정규화 경로 보호 검사 → 대상 존재/링크 → realpath 보호 검사 → 규칙 범위
   */
  async evaluate(
    rawPath: string,
    rule: LoadedRule,
    mode: CleanupMode,
    acknowledgeCaution: boolean
  ): Promise<GuardVerdict> {
    const { protectedPaths, matcher, fs, settings } = this.#deps

    const ruleVerdict = judgeRule(rule, mode, acknowledgeCaution, settings.allowPermanentDelete())
    if (ruleVerdict) return ruleVerdict

    const clean = sanitizeRawPath(rawPath)
    if (!clean.ok) return deny('invalid-path', clean.detail)
    const lexicalKey = normalizeKey(clean.path)
    const specialAction = rule.rule.cleanup?.specialAction

    const protectedVerdict = (key: string, name: string): GuardVerdict | null => {
      if (protectedPaths.status(key, specialAction) === 'protected') {
        return deny('protected-path', '보호 경로입니다 (SAFETY.md §3).')
      }
      if (isProtectedFileName(name)) return deny('protected-path', '보호 대상 파일 이름입니다.')
      return null
    }
    const lastName = (p: string): string => p.slice(p.lastIndexOf('\\') + 1)

    const lexicalProtected = protectedVerdict(lexicalKey, lastName(lexicalKey))
    if (lexicalProtected) return lexicalProtected

    try {
      if ((await fs.lstat(clean.path)).isSymbolicLink) {
        return deny('link', '심볼릭 링크/정션은 따라가지도 지우지도 않습니다.')
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        return deny('not-found', '대상이 없습니다.')
      }
      return deny('invalid-path', '대상을 확인할 수 없습니다.')
    }

    let real: string
    try {
      real = await fs.realpath(clean.path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return deny('not-found', '대상이 없습니다.')
      return deny('invalid-path', '실제 경로를 확인할 수 없습니다.')
    }
    const realClean = sanitizeRawPath(real)
    if (!realClean.ok) return deny('invalid-path', `실제 경로가 비정상입니다: ${realClean.detail}`)
    const realKey = normalizeKey(realClean.path)
    const realProtected = protectedVerdict(realKey, lastName(realKey))
    if (realProtected) return realProtected

    // 규칙 범위: 입력 경로와 실제 경로 모두 "이 항목의 규칙"이 가장 구체적인 규칙이어야 한다
    for (const key of realKey === lexicalKey ? [lexicalKey] : [lexicalKey, realKey]) {
      const found = matcher.lookup(key)
      const match = found.match
      if (match.ruleId !== rule.rule.id) {
        if (match.ruleId === 'hardcoded-protected')
          return deny('protected-path', '보호 경로입니다.')
        if (match.safety === 'protected')
          return deny('protected-rule', '보호 규칙이 가리키는 곳입니다.')
        if (match.ruleId === null)
          return deny('unknown-rule', '규칙이 없는 경로입니다 (안전도 알 수 없음).')
        return deny('outside-scope', '이 정리 항목의 규칙 범위 밖입니다.')
      }
      // contents 모드는 규칙 루트 폴더 자체를 남긴다. self 모드만 루트(와 그 안)를 지울 수 있다
      if (rule.rule.cleanup?.mode === 'contents' && found.root) {
        return deny('self-not-allowed', '폴더 자체는 지우지 않고 내용물만 지웁니다.')
      }
    }
    return { allowed: true, ruleId: rule.rule.id, realPath: realClean.path }
  }
}
