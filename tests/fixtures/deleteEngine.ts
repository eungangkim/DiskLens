// 삭제 엔진 조립 도우미 (테스트 전용). 샌드박스의 가짜 드라이브 env 로 보호 경로/규칙/관문을 만든다.
import { mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PathRule } from '../../src/shared/rules.ts'
import { createNodeRemovePort, type RemovePort } from '../../src/main/cleaner/fsPort.ts'
import { createMemoryHistory } from '../../src/main/cleaner/history.ts'
import { createMemoryLogger, type CleanupLogger } from '../../src/main/cleaner/log.ts'
import type { AdminCleanupPort } from '../../src/main/helper/types.ts'
import type { CleanupProgress } from '../../src/shared/cleanup.ts'
import { Remover } from '../../src/main/cleaner/remover.ts'
import { CleanupService, type SpecialActionPort } from '../../src/main/cleaner/service.ts'
import { ConfirmationStore } from '../../src/main/safety/confirmation.ts'
import { DeleteGuard } from '../../src/main/safety/deleteGuard.ts'
import { nodeFsReader, type FsReader } from '../../src/main/safety/fsReader.ts'
import { createProtectedPaths } from '../../src/main/safety/protectedPaths.ts'
import type { Sandbox } from './deleteSandbox.ts'

export interface EngineOptions {
  allowPermanent?: boolean
  fs?: FsReader
  /** 영구 삭제 포트를 바꿔 끼운다 (EBUSY 흉내 등) */
  port?: RemovePort
  special?: SpecialActionPort
  /** 관리자 헬퍼 포트 (테스트에서는 가짜 UAC 로 헬퍼를 같은 프로세스에서 돌린다) */
  admin?: AdminCleanupPort
  /** 작업/계획 ID 생성기 (기본: id-1, id-2 …) */
  newId?: () => string
  clock?: { t: number }
  ttlMs?: number
  logger?: CleanupLogger
  onProgress?: (progress: CleanupProgress) => void
}

/** 휴지통을 흉내 내는 포트: 파일을 샌드박스의 `.trash` 로 옮기고 호출을 기록한다. 실제 휴지통은 쓰지 않는다 */
export function fakeTrash(sb: Sandbox): {
  calls: string[]
  fail: { on: boolean }
  trash: (p: string) => Promise<void>
} {
  const calls: string[] = []
  const fail = { on: false }
  const dir = sb.p('.trash')
  return {
    calls,
    fail,
    trash(path) {
      calls.push(path)
      if (fail.on) return Promise.reject(Object.assign(new Error('trash failed'), { code: 'EIO' }))
      mkdirSync(dir, { recursive: true })
      renameSync(path, join(dir, `${calls.length}-${basename(path)}`))
      return Promise.resolve()
    }
  }
}

export function buildEngine(sb: Sandbox, rules: PathRule[], options: EngineOptions = {}) {
  const set = sb.ruleSet(rules)
  if (set.issues.length > 0) throw new Error(`테스트 규칙이 거부됨: ${JSON.stringify(set.issues)}`)
  const settings = { allow: options.allowPermanent ?? true }
  const fs = options.fs ?? nodeFsReader
  const protectedPaths = createProtectedPaths({ env: sb.env })
  const guard = new DeleteGuard({
    protectedPaths,
    matcher: set.matcher,
    fs,
    settings: { allowPermanentDelete: () => settings.allow }
  })
  const trash = fakeTrash(sb)
  const port = options.port ?? createNodeRemovePort(trash.trash)
  const remover = new Remover(guard, port, fs)
  const clock = options.clock ?? { t: Date.now() }
  const confirmations = new ConfirmationStore({
    now: () => clock.t,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {})
  })
  const memoryLogger = createMemoryLogger()
  const logger = options.logger ?? memoryLogger
  const history = createMemoryHistory()
  let counter = 0
  const service = new CleanupService({
    rules: set.matcher.rules,
    guard,
    remover,
    fs,
    confirmations,
    logger,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    history,
    settings: { allowPermanentDelete: () => settings.allow },
    ...(options.special ? { special: options.special } : {}),
    ...(options.admin ? { admin: options.admin } : {}),
    newId: options.newId ?? (() => `id-${++counter}`)
  })
  return {
    set,
    guard,
    remover,
    confirmations,
    service,
    logger: memoryLogger,
    history,
    settings,
    trash,
    clock,
    rules: set.matcher.rules
  }
}
