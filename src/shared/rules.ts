// 규칙 DB 타입과 zod 스키마 (DATA_SPEC.md §1). 구조 검사만 한다.
// 안전 검증(보호 경로 침범, 과도하게 넓은 패턴 등)은 main/rules/validate.ts 가 맡는다.
import { z } from 'zod'

export const RULE_CATEGORIES = [
  'temp',
  'cache',
  'log',
  'dump',
  'update',
  'dev-cache',
  'dev-build',
  'app-data',
  'system',
  'user-data',
  'program',
  'game',
  'vm',
  'other'
] as const

const nonEmpty = z.string().min(1)

export const cleanupSchema = z
  .object({
    mode: z.enum(['contents', 'self']),
    includeGlobs: z.array(nonEmpty).optional(),
    excludeGlobs: z.array(nonEmpty).optional(),
    minAgeDays: z.number().min(0).optional(),
    requiresAdmin: z.boolean(),
    allowPermanent: z.boolean(),
    group: nonEmpty,
    defaultSelected: z.boolean(),
    needsProcessClosed: z.array(nonEmpty).optional(),
    specialAction: z.enum(['empty-recycle-bin', 'run-disk-cleanup']).optional()
  })
  .strict()

export const pathRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, '소문자 kebab-case 여야 합니다'),
    name: nonEmpty,
    match: z
      .object({ kind: z.enum(['exact', 'prefix', 'glob', 'name']), pattern: nonEmpty })
      .strict(),
    category: z.enum(RULE_CATEGORIES),
    // unknown 은 "규칙 없음" 상태이므로 규칙에 쓸 수 없다
    safety: z.enum(['safe', 'caution', 'protected']),
    description: nonEmpty,
    impact: nonEmpty,
    cleanable: z.boolean(),
    cleanup: cleanupSchema.optional(),
    tags: z.array(z.string()).optional(),
    reference: z.string().optional()
  })
  .strict()

export const programRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    match: z
      .object({
        nameContains: z.array(nonEmpty).optional(),
        nameRegex: nonEmpty.optional(),
        publisherContains: z.array(nonEmpty).optional()
      })
      .strict(),
    name: nonEmpty,
    category: z.enum([
      'driver',
      'runtime',
      'redistributable',
      'security',
      'system',
      'dev-tool',
      'game-launcher',
      'app',
      'other'
    ]),
    safety: z.enum(['safe', 'caution', 'protected']),
    description: nonEmpty,
    impact: nonEmpty
  })
  .strict()

/** 파일 최상위 구조. 규칙 하나가 잘못돼도 파일 전체가 거부되지 않도록 개별 규칙은 unknown 으로 받는다 */
export const rulesFileSchema = z.object({
  schemaVersion: z.literal(1),
  rulesVersion: z.string(),
  description: z.string().optional(),
  pathRules: z.array(z.unknown()),
  programRules: z.array(z.unknown()).default([])
})

export type PathRule = z.infer<typeof pathRuleSchema>
export type ProgramRule = z.infer<typeof programRuleSchema>
export type CleanupSpec = z.infer<typeof cleanupSchema>
export type RuleSource = 'builtin' | 'user'

/** 로드가 거부된 규칙과 사유. code 는 DATA_SPEC §1.2 의 검증 규칙 번호와 대응한다 */
export type RuleIssueCode =
  | 'schema' // 구조 오류 (필드 누락/형식)
  | 'invalid-pattern' // 패턴을 해석할 수 없음 (빈 값, 알 수 없는 환경변수, 절대 경로 아님)
  | 'cleanable-protected' // 1
  | 'cleanup-missing' // 2
  | 'permanent-category' // 3
  | 'default-selected-not-safe' // 4
  | 'protected-path' // 5
  | 'too-broad' // 6
  | 'duplicate-id' // 7
  | 'protected-downgrade' // 8
  | 'user-privileged' // 사용자 규칙은 관리자 권한/전용 동작 항목을 만들 수 없다 (ARCHITECTURE.md §7)

export interface RuleIssue {
  ruleId: string
  source: RuleSource
  code: RuleIssueCode
  message: string
}
