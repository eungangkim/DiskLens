// 설치 프로그램 서비스: 레지스트리(읽기) → 파싱 → 프로그램 규칙 매칭 → 스캔 결과와 연결.
// 이 파일에는 쓰기/실행 동작이 없다. 제거 실행은 uninstall.ts 가 맡는다.
import type { InstalledProgram, RuleMatch } from '../../shared/types.ts'
import type { UninstallBlock } from '../../shared/uninstall.ts'
import { AppError } from '../ipc/errors.ts'
import { parseUninstallCommand, type CommandEnv } from './command.ts'
import { ProgramRuleMatcher } from './matcher.ts'
import { parseEntries, type ProgramRecord } from './parse.ts'
import type { RegistryReader } from './registry.ts'

/** 현재 스캔 결과에서 폴더를 찾는 기능 (ScanService.locate 가 구현) */
export interface ScanLocator {
  locate(path: string): { scanId: string; nodeId: string; size: number } | null
}

export interface ProgramServiceOptions {
  reader: RegistryReader
  matcher: ProgramRuleMatcher
  scan?: ScanLocator
  /** 있으면 제거 가능 여부(canUninstall)를 계산한다. 없으면 항상 false */
  commandEnv?: CommandEnv
  log?: (message: string, error?: unknown) => void
}

export class ProgramService {
  readonly #reader: RegistryReader
  readonly #matcher: ProgramRuleMatcher
  readonly #scan: ScanLocator | undefined
  readonly #commandEnv: CommandEnv | undefined
  readonly #log: (message: string, error?: unknown) => void
  #records: ProgramRecord[] | null = null
  #loading: Promise<ProgramRecord[]> | null = null

  constructor(options: ProgramServiceOptions) {
    this.#reader = options.reader
    this.#matcher = options.matcher
    this.#scan = options.scan
    this.#commandEnv = options.commandEnv
    this.#log = options.log ?? (() => undefined)
  }

  /** 레지스트리를 읽어 둔다. 동시에 여러 번 불러도 한 번만 읽는다 */
  load(refresh = false): Promise<ProgramRecord[]> {
    if (this.#records && !refresh) return Promise.resolve(this.#records)
    if (this.#loading) return this.#loading
    this.#loading = this.#reader
      .readUninstallEntries()
      .then((entries) => {
        this.#records = parseEntries(entries)
        return this.#records
      })
      .finally(() => {
        this.#loading = null
      })
    return this.#loading
  }

  /** 읽어 둔 설치 폴더들 (스캔 시 접지 않을 경로 힌트용). 아직 못 읽었으면 빈 배열 */
  installLocations(): string[] {
    const set = new Set<string>()
    for (const r of this.#records ?? []) {
      // 드라이브 바로 아래 한 단계(C:\Games 등)는 너무 넓어 힌트로 쓰지 않는다
      if (r.installLocation && r.installLocation.split('\\').length >= 3) set.add(r.installLocation)
    }
    return [...set]
  }

  async list(includeSystem: boolean, refresh: boolean): Promise<InstalledProgram[]> {
    let records: ProgramRecord[]
    try {
      records = await this.load(refresh)
    } catch (error) {
      this.#log('설치 프로그램 목록 읽기 실패', error)
      throw new AppError('INTERNAL', '설치 프로그램 목록을 읽지 못했습니다.')
    }
    return records.filter((r) => includeSystem || !r.isSystemComponent).map((r) => this.#view(r))
  }

  /** 제거 가능 여부와 막힌 이유. 형식 검사까지만 한다 (실행하지 않는다) */
  #uninstallState(r: ProgramRecord, match: RuleMatch): { can: boolean; block?: UninstallBlock } {
    if (!this.#commandEnv) return { can: false }
    if (match.safety === 'protected') return { can: false, block: 'protected' }
    if (!r.uninstallCommand) return { can: false, block: 'no-command' }
    const parsed = parseUninstallCommand(r.uninstallCommand, this.#commandEnv)
    return parsed.ok ? { can: true } : { can: false, block: 'unsupported-command' }
  }

  /** programId → 내부 기록과 규칙 판정 (제거 서비스용). 모르는 ID 면 null */
  async find(
    programId: string,
    refresh = false
  ): Promise<{ record: ProgramRecord; match: RuleMatch } | null> {
    const records = await this.load(refresh)
    const record = records.find((r) => r.id === programId)
    return record ? { record, match: this.#matcher.match(record) } : null
  }

  #view(r: ProgramRecord): InstalledProgram {
    const match = this.#matcher.match(r)
    const uninstall = this.#uninstallState(r, match)
    const located = r.installLocation ? this.#scan?.locate(r.installLocation) : null
    const view: InstalledProgram = {
      id: r.id,
      name: r.name,
      sizeSource: 'unknown',
      isSystemComponent: r.isSystemComponent,
      scope: r.scope,
      match,
      canUninstall: uninstall.can
    }
    if (uninstall.block) view.uninstallBlock = uninstall.block
    if (r.publisher) view.publisher = r.publisher
    if (r.version) view.version = r.version
    if (r.installDate) view.installDate = r.installDate
    if (r.installLocation) view.installLocation = r.installLocation
    if (r.estimatedSizeBytes !== undefined) {
      view.estimatedSizeBytes = r.estimatedSizeBytes
      view.sizeSource = 'registry'
    } else if (located) {
      // 레지스트리에 용량이 없으면 설치 폴더의 스캔 결과로 보완한다
      view.estimatedSizeBytes = located.size
      view.sizeSource = 'scan'
    }
    if (located) view.scanNode = { scanId: located.scanId, nodeId: located.nodeId }
    return view
  }

  /** programId → 설치 폴더 (탐색기 열기용). 모르는 ID 나 설치 폴더가 없는 프로그램은 NOT_FOUND */
  async installLocationOf(programId: string): Promise<string> {
    const records = await this.load(false)
    const found = records.find((r) => r.id === programId)
    if (!found?.installLocation) {
      throw new AppError('NOT_FOUND', '이 프로그램의 설치 폴더 정보가 없습니다.')
    }
    return found.installLocation
  }
}
