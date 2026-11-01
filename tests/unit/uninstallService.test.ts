// 프로그램 제거 서비스 테스트 (TEST_PLAN.md §4.6, ROADMAP 9단계).
// 실제로 설치된 프로그램의 제거 명령은 어디에서도 실행하지 않는다:
//  - 레지스트리는 샌드박스의 가짜 JSON 파일(FileRegistryReader)이고,
//  - "제거 프로그램"은 node.exe + tests/fixtures/mockUninstaller.ts 의 모의 스크립트다 (샌드박스 안에만 쓴다).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger, type CleanupLogger } from '../../src/main/cleaner/log.ts'
import type { ElevationPort } from '../../src/main/helper/elevation.ts'
import { AppError } from '../../src/main/ipc/errors.ts'
import { uninstallSchema, programIdSchema } from '../../src/main/ipc/programSchemas.ts'
import { ProgramRuleMatcher } from '../../src/main/programs/matcher.ts'
import { FileRegistryReader } from '../../src/main/programs/registry.ts'
import { ProgramService } from '../../src/main/programs/service.ts'
import {
  UninstallService,
  createNodeProcessPort,
  interpretExitCode,
  type ProcessOutcome,
  type ProcessPort
} from '../../src/main/programs/uninstall.ts'
import { ConfirmationStore } from '../../src/main/safety/confirmation.ts'
import type { ProgramRule } from '../../src/shared/rules.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'
import { createMockInstall, fakeEntry, type MockInstall } from '../fixtures/mockUninstaller.ts'

const RULES: ProgramRule[] = [
  {
    id: 'prog-nvidia',
    match: { nameRegex: '^NVIDIA Graphics Driver' },
    name: 'NVIDIA 그래픽 드라이버',
    category: 'driver',
    safety: 'protected',
    description: '그래픽 카드 드라이버입니다.',
    impact: '지우면 화면이 제대로 나오지 않을 수 있습니다.'
  },
  {
    id: 'prog-vcredist',
    match: { nameContains: ['Visual C++', 'Redistributable'] },
    name: 'Visual C++ 재배포 패키지',
    category: 'redistributable',
    safety: 'caution',
    description: '여러 프로그램이 함께 쓰는 런타임입니다.',
    impact: '다른 프로그램이 실행되지 않을 수 있습니다.'
  }
]

let sb: Sandbox
let mock: MockInstall
let logger: ReturnType<typeof createMemoryLogger>

beforeEach(() => {
  sb = createSandbox()
  mock = createMockInstall(sb, 'MockApp')
  logger = createMemoryLogger()
  sb.write('Program Files/MockApp/app.dll', 'dll')
  sb.write('Program Files/MockApp/data/config.ini', 'cfg')
})
afterEach(() => sb.dispose())

const installDir = (): string => sb.p('Program Files', 'MockApp')

function entry(over: Record<string, unknown> = {}, key = 'MockApp') {
  return fakeEntry(key, {
    DisplayName: 'Mock App',
    Publisher: 'Mock Co',
    DisplayVersion: '1.2.3',
    EstimatedSize: 2048,
    InstallLocation: installDir(),
    UninstallString: mock.uninstallString(),
    // QuietUninstallString 은 쓰지 않는다: 일부러 이상한 값을 넣어, 쓰였다면 테스트가 깨지게 한다
    QuietUninstallString: '"C:\\does\\not\\exist.exe" /S',
    ...over
  })
}

interface Setup {
  programs: ProgramService
  service: UninstallService
  calls: Array<{ exe: string; args: readonly string[] }>
  clock: { t: number }
}

/** 실제 프로세스 포트(모의 제거 프로그램을 진짜로 실행)를 감싸서 호출을 기록한다 */
function setup(
  entries: ReturnType<typeof entry>[],
  options: {
    process?: ProcessPort
    elevation?: ElevationPort
    logger?: CleanupLogger
    locate?: (path: string) => { scanId: string; nodeId: string; size: number } | null
  } = {}
): Setup {
  mock.writeRegistry(entries)
  const env = {
    fileExists: (p: string): boolean => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    },
    systemDir: sb.p('Windows', 'System32')
  }
  const programs = new ProgramService({
    reader: new FileRegistryReader(mock.registry),
    matcher: new ProgramRuleMatcher(RULES),
    commandEnv: env
  })
  const calls: Setup['calls'] = []
  const inner = options.process ?? createNodeProcessPort()
  const clock = { t: Date.now() }
  const service = new UninstallService({
    programs,
    env,
    process: {
      run: (exe, args) => {
        calls.push({ exe, args })
        return inner.run(exe, args)
      }
    },
    ...(options.elevation ? { elevation: options.elevation } : {}),
    confirmations: new ConfirmationStore({ now: () => clock.t }),
    logger: options.logger ?? logger,
    ...(options.locate ? { scan: { locate: options.locate } } : {}),
    dirExists: (p) => existsSync(p),
    now: () => clock.t
  })
  return { programs, service, calls, clock }
}

async function idOf(s: Setup, name = 'Mock App'): Promise<string> {
  const list = await s.programs.list(true, false)
  const found = list.find((p) => p.name === name)
  if (!found) throw new Error(`목록에 없음: ${name}`)
  return found.id
}

const run = async (s: Setup, programId: string, ack = false) => {
  const plan = await s.service.plan(programId)
  const { done } = await s.service.start({
    programId,
    confirmationId: plan.confirmationId,
    acknowledgeCaution: ack
  })
  return { plan, result: await done }
}

async function denied(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('거부되어야 하는데 성공했습니다')
}

describe('모의 제거 프로그램 실행 (실제 프로세스, 샌드박스 안)', () => {
  it('성공: 공식 제거 명령을 셸 없이 실행하고, 목록에서 사라지며, 설치 폴더는 지우지 않고 알려 준다', async () => {
    const s = setup([entry()], {
      locate: (path) =>
        path === installDir() ? { scanId: 'scan-1', nodeId: 'n7', size: 10 } : null
    })
    const id = await idOf(s)
    const { plan, result } = await run(s, id)

    expect(plan).toMatchObject({
      name: 'Mock App',
      publisher: 'Mock Co',
      version: '1.2.3',
      sizeBytes: 2048 * 1024,
      installerKind: 'exe',
      installerName: 'node.exe',
      needsCautionAck: false
    })
    expect(result).toMatchObject({
      status: 'finished',
      exitCode: 0,
      rebootRequired: false,
      stillListed: false
    })
    expect(existsSync(mock.marker)).toBe(true) // 모의 제거 프로그램이 실제로 실행됨
    // 인자가 분리되어 그대로 전달됨 (공백 있는 경로가 하나의 인자로)
    expect(JSON.parse(readFileSync(mock.argsOut, 'utf8'))).toEqual([
      '--marker',
      mock.marker,
      '--registry',
      mock.registry,
      '--key',
      'MockApp',
      '--args-out',
      mock.argsOut
    ])
    // QuietUninstallString 이 아니라 UninstallString 이 실행되었다
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]?.exe).toBe(process.execPath)
    expect(s.calls[0]?.args[0]).toBe(mock.script)

    // 남은 폴더 후보: 알려 주기만 하고 지우지 않는다
    expect(result.leftover).toEqual({
      path: installDir(),
      scanNode: { scanId: 'scan-1', nodeId: 'n7' }
    })
    expect(sb.exists('Program Files/MockApp/app.dll')).toBe(true)
    expect(sb.exists('Program Files/MockApp/data/config.ini')).toBe(true)

    // 목록이 새로 읽혀 항목이 사라짐
    expect((await s.programs.list(true, false)).some((p) => p.name === 'Mock App')).toBe(false)
    // 기록: 시작과 끝
    const ops = logger.entries.filter((e) => e.op === 'uninstall')
    expect(ops.map((e) => e.result)).toEqual(['start', 'end'])
    expect(ops[0]?.path).toBe(process.execPath)
    expect(ops[1]?.detail).toContain('exit=0')
  })

  it('설치 폴더가 이미 없으면 남은 폴더 알림이 없다', async () => {
    sb.remove('Program Files/MockApp')
    const s = setup([entry()])
    const { result } = await run(s, await idOf(s))
    expect(result.status).toBe('finished')
    expect(result.leftover).toBeUndefined()
  })

  it('종료 코드 해석: 3010=재부팅 필요(성공), 1602=사용자 취소, 그 밖의 코드=실패', async () => {
    const cases: Array<[string, Partial<Record<string, unknown>>]> = [
      ['3010', { status: 'finished', rebootRequired: true, exitCode: 3010 }],
      ['1602', { status: 'cancelled', exitCode: 1602 }],
      ['1', { status: 'failed', exitCode: 1 }],
      ['5', { status: 'failed', exitCode: 5 }]
    ]
    for (const [code, expected] of cases) {
      mock.writeRegistry([entry({ UninstallString: mock.uninstallString(`--exit ${code}`) })])
      const s = setup([entry({ UninstallString: mock.uninstallString(`--exit ${code}`) })])
      const { result } = await run(s, await idOf(s))
      expect(result, code).toMatchObject(expected)
      if (expected['status'] === 'failed') expect(result.message).toContain(code)
    }
  })

  it('종료 코드는 0 인데 목록에 아직 남아 있으면 그렇다고 알려 준다 (제거 프로그램이 다른 창에서 계속될 수 있음)', async () => {
    const s = setup([
      entry({
        UninstallString: mock.uninstallString('--exit 0').replace('--key MockApp', '--key Other')
      })
    ])
    const { result } = await run(s, await idOf(s))
    expect(result).toMatchObject({ status: 'finished', stillListed: true })
    expect(result.message).toContain('아직 남아 있습니다')
    expect(result.leftover).toBeUndefined()
  })

  it('오래 걸리는 제거: 끝날 때까지 기다리고, 그 사이 다른 제거는 BUSY 로 거부된다', async () => {
    const s = setup([
      entry({ UninstallString: mock.uninstallString('--sleep 500') }),
      entry({ DisplayName: 'Second App' }, 'SecondApp')
    ])
    const first = await idOf(s)
    const second = await idOf(s, 'Second App')
    const plan1 = await s.service.plan(first)
    const plan2 = await s.service.plan(second)
    const started = await s.service.start({
      programId: first,
      confirmationId: plan1.confirmationId,
      acknowledgeCaution: false
    })
    expect(s.service.running).toBe(true)
    const err = await denied(
      s.service.start({
        programId: second,
        confirmationId: plan2.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.code).toBe('BUSY')
    expect(s.calls).toHaveLength(1)
    expect((await started.done).status).toBe('finished')
    expect(s.service.running).toBe(false)
  })
})

describe('확인 토큰', () => {
  it('일회용: 같은 토큰으로 두 번 실행할 수 없다', async () => {
    const s = setup([entry({ UninstallString: mock.uninstallString('--exit 1') })])
    const id = await idOf(s)
    const plan = await s.service.plan(id)
    const req = { programId: id, confirmationId: plan.confirmationId, acknowledgeCaution: false }
    await (
      await s.service.start(req)
    ).done
    const err = await denied(s.service.start(req))
    expect(err.code).toBe('NOT_FOUND') // 계획은 한 번만 쓸 수 있다
    expect(s.calls).toHaveLength(1)
  })
  it('엉뚱한 토큰, 다른 프로그램의 토큰, 만료된 토큰은 실행되지 않는다', async () => {
    const s = setup([entry(), entry({ DisplayName: 'Second App' }, 'SecondApp')])
    const a = await idOf(s)
    const b = await idOf(s, 'Second App')
    const planA = await s.service.plan(a)
    await s.service.plan(b)

    const bad = { programId: a, confirmationId: 'f'.repeat(64), acknowledgeCaution: false }
    expect((await denied(s.service.start(bad))).code).toBe('SAFETY_DENIED')
    const crossed = {
      programId: b,
      confirmationId: planA.confirmationId,
      acknowledgeCaution: false
    }
    expect((await denied(s.service.start(crossed))).code).toBe('SAFETY_DENIED')

    s.clock.t += 10 * 60_000 // 5분 TTL 지남
    const late = { programId: a, confirmationId: planA.confirmationId, acknowledgeCaution: false }
    expect((await denied(s.service.start(late))).message).toContain('시간이 지났습니다')
    expect(s.calls).toHaveLength(0)
    expect(existsSync(mock.marker)).toBe(false)
  })
  it('계획 이후 레지스트리의 제거 명령이 바뀌면 실행하지 않는다', async () => {
    const s = setup([entry()])
    const id = await idOf(s)
    const plan = await s.service.plan(id)
    // 계획 이후 누군가 UninstallString 을 바꿈 (예: 사용자 권한 프로그램이 HKCU 값을 변조)
    mock.writeRegistry([entry({ UninstallString: mock.uninstallString('--exit 9') })])
    const err = await denied(
      s.service.start({
        programId: id,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.message).toContain('바뀌었습니다')
    expect(s.calls).toHaveLength(0)
  })
  it('계획 없이는 실행할 수 없다', async () => {
    const s = setup([entry()])
    const err = await denied(
      s.service.start({
        programId: await idOf(s),
        confirmationId: 'a'.repeat(64),
        acknowledgeCaution: true
      })
    )
    expect(err.code).toBe('NOT_FOUND')
    expect(s.calls).toHaveLength(0)
  })
})

describe('안전도', () => {
  const gpu = (): ReturnType<typeof entry> =>
    entry({ DisplayName: 'NVIDIA Graphics Driver 551.23' }, 'NvDrv')

  it('protected: 목록에서 제거 불가로 표시되고, 계획·실행이 거부되며 아무것도 실행하지 않는다', async () => {
    const s = setup([entry(), gpu()])
    const list = await s.programs.list(true, false)
    const nv = list.find((p) => p.name.startsWith('NVIDIA'))
    expect(nv).toMatchObject({ canUninstall: false, uninstallBlock: 'protected' })
    expect(list.find((p) => p.name === 'Mock App')?.canUninstall).toBe(true)

    const err = await denied(s.service.plan(nv?.id ?? ''))
    expect(err.code).toBe('SAFETY_DENIED')
    expect(err.message).toContain('제거할 수 없습니다')
    // 계획 없이 바로 실행을 시도해도 실행되지 않는다
    await denied(
      s.service.start({
        programId: nv?.id ?? '',
        confirmationId: 'a'.repeat(64),
        acknowledgeCaution: true
      })
    )
    expect(s.calls).toHaveLength(0)
    expect(existsSync(mock.marker)).toBe(false)
  })

  it('caution: 경고 문구를 보여 주고, 경고 확인 없이는 실행하지 않는다 (확인하면 같은 토큰으로 다시 가능)', async () => {
    const s = setup([
      entry({ DisplayName: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)' }, 'VcRedist')
    ])
    const id = await idOf(s, 'Microsoft Visual C++ 2015-2022 Redistributable (x64)')
    const plan = await s.service.plan(id)
    expect(plan.safety).toBe('caution')
    expect(plan.needsCautionAck).toBe(true)
    expect(plan.warnings).toContain('다른 프로그램이 실행되지 않을 수 있습니다.')

    const req = { programId: id, confirmationId: plan.confirmationId, acknowledgeCaution: false }
    expect((await denied(s.service.start(req))).message).toContain('경고를 확인')
    expect(s.calls).toHaveLength(0)
    const { done } = await s.service.start({ ...req, acknowledgeCaution: true })
    expect((await done).status).toBe('finished')
    expect(s.calls).toHaveLength(1)
  })

  it('규칙이 없는 시스템 구성요소는 caution 으로 취급한다', async () => {
    const s = setup([entry({ SystemComponent: 1 })])
    const plan = await s.service.plan(await idOf(s))
    expect(plan.needsCautionAck).toBe(true)
    expect(plan.warnings.length).toBeGreaterThan(0)
  })

  it('규칙이 없는 일반 프로그램(unknown)은 제거할 수 있다', async () => {
    const s = setup([entry()])
    const plan = await s.service.plan(await idOf(s))
    expect(plan.safety).toBe('unknown')
    expect(plan.needsCautionAck).toBe(false)
  })
})

describe('제거 명령이 위험하거나 없을 때', () => {
  const bad = async (uninstallString: unknown, block: string): Promise<void> => {
    const s = setup([entry({ UninstallString: uninstallString })])
    const list = await s.programs.list(true, false)
    expect(list[0], String(uninstallString)).toMatchObject({
      canUninstall: false,
      uninstallBlock: block
    })
    const err = await denied(s.service.plan(list[0]?.id ?? ''))
    expect(err.code).toBe('SAFETY_DENIED')
    expect(s.calls).toHaveLength(0)
    expect(existsSync(mock.marker)).toBe(false)
  }

  it('셸 명령(cmd /c …)·인자 주입·상대경로·스크립트 파일은 계획 단계에서 거부', async () => {
    await bad('cmd.exe /c del /s /q C:\\Users', 'unsupported-command')
    await bad(`${mock.uninstallString()} & calc.exe`, 'unsupported-command')
    await bad(`${mock.uninstallString()}\r\ncalc.exe`, 'unsupported-command')
    await bad('uninstall.exe /S', 'unsupported-command')
    await bad('"C:\\Tools\\run.bat"', 'unsupported-command')
    await bad('"C:\\does\\not\\exist.exe"', 'unsupported-command')
  })
  it('UninstallString 이 없으면 QuietUninstallString 이 있어도 제거할 수 없다 (자동 제거는 쓰지 않는다)', async () => {
    const s = setup([
      fakeEntry('NoCmd', {
        DisplayName: 'No Command App',
        QuietUninstallString: mock.uninstallString()
      })
    ])
    const [p] = await s.programs.list(true, false)
    expect(p).toMatchObject({ canUninstall: false, uninstallBlock: 'no-command' })
    const err = await denied(s.service.plan(p?.id ?? ''))
    expect(err.message).toContain('제거 명령이 없습니다')
    expect(s.calls).toHaveLength(0)
  })
  it('모르는 programId 는 NOT_FOUND', async () => {
    const s = setup([entry()])
    expect((await denied(s.service.plan('nope#0000000000'))).code).toBe('NOT_FOUND')
  })
})

describe('기록(로그)과 실패 처리', () => {
  it('시작 기록을 쓸 수 없으면 제거를 시작하지 않는다', async () => {
    const failing: CleanupLogger = { write: () => Promise.reject(new Error('disk full')) }
    const s = setup([entry()], { logger: failing })
    const id = await idOf(s)
    const plan = await s.service.plan(id)
    const err = await denied(
      s.service.start({
        programId: id,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
    )
    expect(err.message).toContain('로그를 쓸 수 없어')
    expect(s.calls).toHaveLength(0)
    expect(existsSync(mock.marker)).toBe(false)
    expect(s.service.running).toBe(false)
  })
  it('실행 파일을 시작하지 못하면(ENOENT) 실패로 처리하고 목록은 그대로다', async () => {
    const missing: ProcessPort = {
      run: () => Promise.resolve({ kind: 'spawn-error', code: 'ENOENT', message: 'spawn ENOENT' })
    }
    const s = setup([entry()], { process: missing })
    const { result } = await run(s, await idOf(s))
    expect(result).toMatchObject({ status: 'failed', stillListed: true })
    expect(result.message).toContain('찾을 수 없어')
    expect(result.leftover).toBeUndefined()
    expect(logger.entries.at(-1)).toMatchObject({ op: 'uninstall', result: 'error' })
  })
})

describe('관리자 권한이 필요한 제거 프로그램', () => {
  const needsAdmin: ProcessPort = {
    run: () => Promise.resolve({ kind: 'spawn-error', code: 'UNKNOWN', message: 'spawn UNKNOWN' })
  }
  const elevation = (outcome: Awaited<ReturnType<ElevationPort['launch']>>) => {
    const launches: Array<{ exe: string; args: readonly string[] }> = []
    const port: ElevationPort = {
      launch: (req) => {
        launches.push(req)
        return Promise.resolve(outcome)
      }
    }
    return { port, launches }
  }

  it('일반 실행이 거부되면 같은 명령을 UAC 로 다시 실행한다 (명령은 바뀌지 않는다)', async () => {
    const e = elevation({ kind: 'exited', code: 0 })
    const s = setup([entry()], { process: needsAdmin, elevation: e.port })
    const { result } = await run(s, await idOf(s))
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
    expect(e.launches).toHaveLength(1)
    expect(e.launches[0]?.exe).toBe(process.execPath)
    expect(e.launches[0]?.args).toEqual(s.calls[0]?.args)
  })
  it('UAC 를 거부하면 제거를 시작하지 않았다고 알리고 앱은 정상이다', async () => {
    const e = elevation({ kind: 'declined' })
    const s = setup([entry()], { process: needsAdmin, elevation: e.port })
    const { result } = await run(s, await idOf(s))
    expect(result).toMatchObject({ status: 'declined', stillListed: true })
    expect(result.message).toContain('관리자 권한을 허용하지 않아')
    expect(s.service.running).toBe(false)
  })
  it('UAC 실행에 실패하거나 UAC 포트가 없으면 실패로 처리', async () => {
    const failed = elevation({ kind: 'failed', detail: '실행 못함' })
    const s1 = setup([entry()], { process: needsAdmin, elevation: failed.port })
    expect((await run(s1, await idOf(s1))).result.status).toBe('failed')
    const s2 = setup([entry()], { process: needsAdmin })
    expect((await run(s2, await idOf(s2))).result.status).toBe('failed')
  })
  it('시작 오류가 권한 문제가 아니면(ENOENT) UAC 로 다시 시도하지 않는다', async () => {
    const e = elevation({ kind: 'exited', code: 0 })
    const enoent: ProcessPort = {
      run: (): Promise<ProcessOutcome> =>
        Promise.resolve({ kind: 'spawn-error', code: 'ENOENT', message: 'x' })
    }
    const s = setup([entry()], { process: enoent, elevation: e.port })
    await run(s, await idOf(s))
    expect(e.launches).toHaveLength(0)
  })
})

describe('종료 코드 해석(interpretExitCode)', () => {
  it('코드별 상태', () => {
    expect(interpretExitCode(0)).toMatchObject({ status: 'finished', rebootRequired: false })
    expect(interpretExitCode(3010)).toMatchObject({ status: 'finished', rebootRequired: true })
    expect(interpretExitCode(1641)).toMatchObject({ status: 'finished', rebootRequired: true })
    expect(interpretExitCode(1602).status).toBe('cancelled')
    expect(interpretExitCode(1223).status).toBe('cancelled')
    expect(interpretExitCode(1605).status).toBe('failed')
    expect(interpretExitCode(-1).status).toBe('failed')
  })
})

describe('IPC 입력 검증: 명령줄이나 경로 필드는 받지 않는다', () => {
  const valid = {
    programId: 'MockApp#abc',
    confirmationId: 'a'.repeat(64),
    acknowledgeCaution: false
  }
  it('올바른 요청만 통과', () => {
    expect(uninstallSchema.safeParse(valid).success).toBe(true)
    expect(programIdSchema.safeParse({ programId: 'MockApp#abc' }).success).toBe(true)
  })
  it('알 수 없는 필드(command, exe, path, args, uninstallString …)는 거부 (strict)', () => {
    for (const extra of [
      { command: 'cmd /c calc' },
      { exe: 'C:\\Windows\\System32\\cmd.exe' },
      { path: 'C:\\' },
      { args: ['/S'] },
      { uninstallString: '"C:\\x.exe"' },
      { quiet: true }
    ]) {
      expect(uninstallSchema.safeParse({ ...valid, ...extra }).success, JSON.stringify(extra)).toBe(
        false
      )
    }
    expect(programIdSchema.safeParse({ programId: 'a', command: 'x' }).success).toBe(false)
  })
  it('필드 누락·잘못된 타입·너무 긴 값은 거부', () => {
    expect(uninstallSchema.safeParse({ programId: 'a', confirmationId: 'b' }).success).toBe(false)
    expect(uninstallSchema.safeParse({ ...valid, acknowledgeCaution: 'yes' }).success).toBe(false)
    expect(uninstallSchema.safeParse({ ...valid, programId: '' }).success).toBe(false)
    expect(uninstallSchema.safeParse({ ...valid, programId: 'x'.repeat(101) }).success).toBe(false)
    expect(uninstallSchema.safeParse({ ...valid, confirmationId: 'x'.repeat(201) }).success).toBe(
      false
    )
    expect(uninstallSchema.safeParse(null).success).toBe(false)
  })
})

describe('정적 규칙: 제거 코드는 셸을 쓰지 않고, 삭제하지 않고, 레지스트리에 쓰지 않는다', () => {
  const dir = resolve(process.cwd(), 'src/main/programs')
  const strip = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const read = (f: string): string => strip(readFileSync(join(dir, f), 'utf8'))

  it('uninstall.ts 는 shell: false 로만 spawn 하고 exec/execSync/shell: true 를 쓰지 않는다', () => {
    const text = read('uninstall.ts')
    expect(text).toMatch(/shell:\s*false/)
    expect(text).not.toMatch(/shell:\s*true/)
    expect(text).not.toMatch(/\b(exec|execSync|execFile|execFileSync|spawnSync)\s*\(/)
  })
  it('파일 삭제 API 와 QuietUninstallString 사용이 없다', () => {
    for (const f of ['uninstall.ts', 'command.ts', 'service.ts']) {
      const text = read(f)
      expect(text, f).not.toMatch(/\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|trashItem)\s*\(/)
      expect(text, f).not.toMatch(/quiet/i)
    }
  })
  it('레지스트리에 쓰는 코드가 없다 (읽기 전용 PowerShell 스크립트와 파일 리더뿐)', () => {
    const text = read('registry.ts')
    expect(text).not.toMatch(
      /Set-ItemProperty|New-ItemProperty|Remove-Item|Remove-ItemProperty|reg\s+(add|delete)/i
    )
  })
})
