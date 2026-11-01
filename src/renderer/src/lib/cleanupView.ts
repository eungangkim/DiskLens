// 정리 화면의 순수 로직 (UI_SPEC.md §4). window 에 의존하지 않아 단위 테스트할 수 있다.
import type { CleanupItem, CleanupItemResult, CleanupPlan, SkipReason } from '@shared/cleanup'

export interface ItemAnalysis {
  status: 'idle' | 'running' | 'done' | 'error'
  fileCount: number
  bytes: number
  sample: string[]
  warnings: string[]
}

export const IDLE_ANALYSIS: ItemAnalysis = {
  status: 'idle',
  fileCount: 0,
  bytes: 0,
  sample: [],
  warnings: []
}

/** UI_SPEC §4.1 그룹 순서. 규칙의 group 이 여기에 없으면 뒤에 가나다순 */
const GROUP_ORDER = ['Windows', '브라우저', '개발 도구', '그래픽', '게임·앱', '기타']

export interface ItemGroup {
  group: string
  items: CleanupItem[]
}

export function groupItems(items: readonly CleanupItem[]): ItemGroup[] {
  const map = new Map<string, CleanupItem[]>()
  for (const item of items) {
    const list = map.get(item.group)
    if (list) list.push(item)
    else map.set(item.group, [item])
  }
  const rank = (g: string): number => {
    const i = GROUP_ORDER.indexOf(g)
    return i === -1 ? GROUP_ORDER.length : i
  }
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, 'ko'))
    .map(([group, list]) => ({
      group,
      items: [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    }))
}

/** 전용 동작(휴지통 비우기/디스크 정리)은 이번 단계에서 실행하지 않는다 → 선택할 수 없다 */
export const isSelectable = (item: CleanupItem): boolean => item.specialAction === undefined

/** 처음 체크 상태: 규칙의 defaultSelected (safe 만 true 가능). 관리자 항목은 UAC 창이 뜨므로 처음부터 체크하지 않는다 */
export function defaultSelection(items: readonly CleanupItem[]): Set<string> {
  return new Set(
    items
      .filter(
        (i) => isSelectable(i) && i.safety === 'safe' && i.defaultSelected && !i.requiresAdmin
      )
      .map((i) => i.itemId)
  )
}

/** [안전 항목만 선택]: safe 인 선택 가능 항목 전부. 관리자 권한 항목은 UAC 창이 뜨므로 직접 체크할 때만 포함 */
export function safeSelection(items: readonly CleanupItem[]): Set<string> {
  return new Set(
    items
      .filter((i) => isSelectable(i) && i.safety === 'safe' && !i.requiresAdmin)
      .map((i) => i.itemId)
  )
}

/** [원클릭 안전 정리]: safe 이면서 규칙이 "기본 선택"으로 표시한 항목만 (caution 은 절대 포함하지 않는다) */
export function oneClickSelection(items: readonly CleanupItem[]): string[] {
  return items
    .filter((i) => isSelectable(i) && i.safety === 'safe' && i.defaultSelected && !i.requiresAdmin)
    .map((i) => i.itemId)
}

export interface Totals {
  fileCount: number
  bytes: number
  /** 분석이 끝난 선택 항목 수 */
  analyzed: number
}

export function selectionTotals(
  selected: ReadonlySet<string>,
  analysis: Readonly<Record<string, ItemAnalysis>>
): Totals {
  let fileCount = 0
  let bytes = 0
  let analyzed = 0
  for (const id of selected) {
    const a = analysis[id]
    if (a?.status === 'done') {
      fileCount += a.fileCount
      bytes += a.bytes
      analyzed++
    }
  }
  return { fileCount, bytes, analyzed }
}

/** 분석이 끝난 모든 항목의 합계 (상단 요약 "예상 확보 약 XX") */
export function analysisTotal(analysis: Readonly<Record<string, ItemAnalysis>>): number {
  return Object.values(analysis).reduce((s, a) => (a.status === 'done' ? s + a.bytes : s), 0)
}

export const SKIP_LABELS: Record<SkipReason, string> = {
  'in-use': '사용 중인 파일',
  'permission-denied': '권한이 없는 파일',
  'safety-denied': '안전 검사에서 제외',
  'not-found': '이미 없어진 파일',
  'admin-declined': '관리자 권한을 허용하지 않아 건너뜀',
  link: '링크 폴더(따라가지 않음)',
  other: '기타 이유'
}

export function summarizeSkips(
  perItem: readonly CleanupItemResult[]
): Array<{ reason: SkipReason; label: string; count: number }> {
  const totals = new Map<SkipReason, number>()
  for (const item of perItem) {
    for (const s of item.skipped) totals.set(s.reason, (totals.get(s.reason) ?? 0) + s.count)
  }
  return [...totals.entries()]
    .map(([reason, count]) => ({ reason, label: SKIP_LABELS[reason], count }))
    .sort((a, b) => b.count - a.count)
}

export type PermanentAvailability = { ok: true } | { ok: false; reason: string }

/** 영구 삭제 선택 가능 여부 (UI_SPEC §4.3): 설정에서 허용 + 선택 항목이 모두 allowPermanent */
export function permanentAvailability(
  items: readonly CleanupItem[],
  selected: readonly string[],
  allowSetting: boolean
): PermanentAvailability {
  if (!allowSetting) {
    return { ok: false, reason: '설정에서 "영구 삭제 허용"을 켜야 선택할 수 있습니다.' }
  }
  const byId = new Map(items.map((i) => [i.itemId, i]))
  const blocked = selected.filter((id) => byId.get(id)?.allowPermanent !== true)
  if (blocked.length > 0) {
    const names = blocked.map((id) => byId.get(id)?.name ?? id).join(', ')
    return { ok: false, reason: `영구 삭제가 허용되지 않는 항목이 있습니다: ${names}` }
  }
  return { ok: true }
}

/** 확인 대화상자에 보일 "가장 큰 항목" 경로 3개 (항목별 대표 경로를 항목 용량 큰 순으로) */
export function largestPaths(plan: CleanupPlan, limit = 3): string[] {
  return [...plan.items]
    .sort((a, b) => b.bytes - a.bytes)
    .flatMap((i) => i.sample)
    .slice(0, limit)
}

/** 확인 대화상자에서 실행 버튼을 켤 수 있는가 */
export function canConfirm(options: {
  plan: CleanupPlan
  permanent: boolean
  cautionAck: boolean
  permanentAck: boolean
}): boolean {
  const { plan, permanent, cautionAck, permanentAck } = options
  if (plan.totalFiles === 0) return false
  if (plan.needsCautionAck && !cautionAck) return false
  if (permanent && !permanentAck) return false
  return true
}
