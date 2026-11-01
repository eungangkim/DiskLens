// 정리 엔진 조립 (프로덕션/E2E 공용). 보호 경로·규칙·관문·삭제기·서비스를 하나로 묶는다.
// 휴지통 함수(trash)는 호출자가 넘긴다: 프로덕션은 shell.trashItem, 개발용 가짜 드라이브는 샌드박스 폴더로 이동.
import { join } from 'node:path'
import type { CleanupProgress } from '../../shared/cleanup.ts'
import type { RuleMatcher } from '../rules/matcher.ts'
import { ConfirmationStore } from '../safety/confirmation.ts'
import { DeleteGuard, type GuardSettings } from '../safety/deleteGuard.ts'
import { nodeFsReader } from '../safety/fsReader.ts'
import { createProtectedPaths, type ProtectedContext } from '../safety/protectedPaths.ts'
import { createNodeRemovePort } from './fsPort.ts'
import type { AdminCleanupPort } from '../helper/types.ts'
import { createFileHistory, type CleanupHistory } from './history.ts'
import { createFileLogger } from './log.ts'
import { Remover } from './remover.ts'
import { CleanupService, type SpecialActionPort } from './service.ts'

export interface CleanupEngineOptions {
  matcher: RuleMatcher
  protectedContext: ProtectedContext
  /** 사용자 데이터 폴더: logs/, cleanup-history.json 이 여기에 생긴다 */
  userDataDir: string
  settings: GuardSettings
  trash: (path: string) => Promise<void>
  special?: SpecialActionPort
  /** UAC 헬퍼 포트 (일반 앱 프로세스). 없으면 관리자 항목은 건너뜀 */
  admin?: AdminCleanupPort
  /** 관리자 헬퍼 프로세스 전용: 관리자 항목을 이 프로세스가 직접 처리한다 */
  isElevatedHelper?: boolean
  /** 기록 저장소를 바꿔 끼운다 (헬퍼는 기록을 main 에 맡기므로 저장하지 않는다) */
  history?: CleanupHistory
  newId?: () => string
  onProgress: (progress: CleanupProgress) => void
}

export function createCleanupEngine(options: CleanupEngineOptions): {
  service: CleanupService
  history: CleanupHistory
} {
  const guard = new DeleteGuard({
    protectedPaths: createProtectedPaths(options.protectedContext),
    matcher: options.matcher,
    fs: nodeFsReader,
    settings: options.settings
  })
  const history =
    options.history ?? createFileHistory(join(options.userDataDir, 'cleanup-history.json'))
  const service = new CleanupService({
    rules: options.matcher.rules,
    guard,
    remover: new Remover(guard, createNodeRemovePort(options.trash), nodeFsReader),
    fs: nodeFsReader,
    confirmations: new ConfirmationStore(),
    logger: createFileLogger(join(options.userDataDir, 'logs')),
    history,
    settings: options.settings,
    ...(options.special ? { special: options.special } : {}),
    ...(options.admin ? { admin: options.admin } : {}),
    ...(options.isElevatedHelper ? { isElevatedHelper: true } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
    onProgress: options.onProgress
  })
  return { service, history }
}
