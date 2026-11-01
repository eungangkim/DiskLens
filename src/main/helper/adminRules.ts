// 관리자 헬퍼가 지울 수 있는 항목의 "하드코딩 허용 목록" (ARCHITECTURE.md §7.2, SAFETY.md §7).
// 사용자 단위 설치/포터블은 설치 폴더가 사용자 쓰기 가능이라 "읽기 전용 규칙 파일"을 믿을 수 없다.
// 그래서 권한 상승 상태에서 지울 수 있는 곳은 이 코드에만 있고, 규칙 DB(JSON)는 설명·표시용이다.
// resources/cleanup-rules.json 과 어긋나지 않는지는 단위 테스트(adminHelper.test.ts)가 검사한다.
import type { PathRule } from '../../shared/rules.ts'

export interface AdminItemSpec {
  id: string
  /** %WINDIR% 로 시작하는 접두 경로. 헬퍼가 검증한 env 로 펼친다 */
  pattern: string
  category: PathRule['category']
  safety: 'safe' | 'caution'
  includeGlobs?: readonly string[]
  minAgeDays?: number
  allowPermanent: boolean
}

export const ADMIN_ITEMS: readonly AdminItemSpec[] = [
  {
    id: 'win-system-temp',
    pattern: '%WINDIR%\\Temp',
    category: 'temp',
    safety: 'safe',
    minAgeDays: 1,
    allowPermanent: true
  },
  {
    id: 'win-minidump',
    pattern: '%WINDIR%\\Minidump',
    category: 'dump',
    safety: 'safe',
    allowPermanent: false
  },
  {
    id: 'win-cbs-logs',
    pattern: '%WINDIR%\\Logs\\CBS',
    category: 'log',
    safety: 'safe',
    includeGlobs: ['*.log'],
    minAgeDays: 30,
    allowPermanent: false
  },
  {
    id: 'win-update-download',
    pattern: '%WINDIR%\\SoftwareDistribution\\Download',
    category: 'cache',
    safety: 'caution',
    allowPermanent: true
  }
]

/** 헬퍼가 받아들이는 항목 ID 전체 */
export const ADMIN_ITEM_IDS: ReadonlySet<string> = new Set(ADMIN_ITEMS.map((i) => i.id))

export function isAdminItemId(id: string): boolean {
  return ADMIN_ITEM_IDS.has(id)
}

/** 허용 목록 → 규칙(PathRule). 이름/설명은 헬퍼가 표시하지 않으므로 최소 문구만 둔다 */
export function adminPathRules(): PathRule[] {
  return ADMIN_ITEMS.map((spec) => ({
    id: spec.id,
    name: spec.id,
    match: { kind: 'prefix', pattern: spec.pattern },
    category: spec.category,
    safety: spec.safety,
    description: '관리자 헬퍼 허용 항목',
    impact: '관리자 헬퍼 허용 항목',
    cleanable: true,
    cleanup: {
      mode: 'contents',
      ...(spec.includeGlobs ? { includeGlobs: [...spec.includeGlobs] } : {}),
      ...(spec.minAgeDays !== undefined ? { minAgeDays: spec.minAgeDays } : {}),
      requiresAdmin: true,
      allowPermanent: spec.allowPermanent,
      group: 'Windows',
      defaultSelected: false
    }
  }))
}
