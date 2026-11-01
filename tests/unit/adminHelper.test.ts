// 관리자 헬퍼 테스트 (TEST_PLAN.md §4.5, ROADMAP 8단계).
// 핵심: 헬퍼는 경로를 받지 않고 규칙 ID 만 받으며, 변조된 job 파일은 아무것도 지우기 전에 거부된다.
// 실제 UAC 는 쓰지 않는다: 가짜 UAC 포트가 헬퍼(runHelper)를 같은 프로세스에서 샌드박스(임시 폴더의 가짜 C 드라이브)로 돌린다.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '../../src/main/helper/adminClient.ts'
import { ADMIN_ITEMS, ADMIN_ITEM_IDS, adminPathRules } from '../../src/main/helper/adminRules.ts'
import {
  ELEVATE_SCRIPT,
  createPowerShellElevation,
  quoteArg,
  type ElevationOutcome,
  type ElevationPort,
  type ExecFileFn
} from '../../src/main/helper/elevation.ts'
import { verifyHelperEnv } from '../../src/main/helper/env.ts'
import {
  JOB_TTL_MS,
  MAX_JOB_BYTES,
  canonicalJob,
  createJob,
  jobSchema,
  sha256Hex,
  signJob,
  verifyJob,
  type Job,
  type JobRejectReason,
  type UnsignedJob
} from '../../src/main/helper/job.ts'
import { CANCEL_FILE, JOB_FILE, RESULT_FILE } from '../../src/main/helper/jobFiles.ts'
import { runHelper } from '../../src/main/helper/runHelper.ts'
import type { PathRule } from '../../src/shared/rules.ts'
import { buildEngine, fakeTrash } from '../fixtures/deleteEngine.ts'
import { createSandbox, type Sandbox } from '../fixtures/deleteSandbox.ts'
import { rule as baseRule } from '../fixtures/ruleHelpers.ts'

const TOKEN = 'a'.repeat(64)
const NOW = 1_700_000_000_000
const JOB_ID = 'job-12345678'

let sb: Sandbox
let userData: string
let elevated: string
let jobFile: string

beforeEach(() => {
  sb = createSandbox()
  userData = sb.p('userdata')
  elevated = sb.mkdir('userdata/elevated')
  jobFile = join(elevated, JOB_FILE)
})
afterEach(() => sb.dispose())

/** 가짜 드라이브에 "지우면 안 되는 것"과 "지워도 되는 것"을 함께 만든다 */
function seed(): void {
  sb.write('Windows/Temp/old.tmp', 'x'.repeat(100), 10)
  sb.write('Windows/Temp/sub/deep.tmp', 'y'.repeat(50), 10)
  sb.write('Windows/Temp/fresh.tmp', 'new', 0) // 최소 보관 기간(1일) 미만
  sb.write('Windows/System32/keep.dll', 'dll', 400)
  sb.write('Windows/Logs/CBS/old.log', 'l', 40)
  sb.write('Windows/Logs/CBS/new.log', 'l', 1)
  sb.write('Windows/Logs/CBS/old.txt', 't', 40) // *.log 만 허용
  sb.write('Windows/Minidump/m.dmp', 'd', 5)
  sb.write('Windows/SoftwareDistribution/Download/pkg.bin', 'p', 5)
  sb.write('Users/tester/Documents/doc.txt', 'important', 400)
  sb.write('Users/tester/AppData/Local/Temp/user.tmp', 'u', 10) // 일반 권한 항목: 헬퍼 대상 아님
}

/** 규칙 밖이거나 헬퍼 대상이 아닌 파일 — 어떤 job 으로도 지워지면 안 된다 */
const MUST_SURVIVE = [
  'Windows/System32/keep.dll',
  'Users/tester/Documents/doc.txt',
  'Users/tester/AppData/Local/Temp/user.tmp'
]
/** 헬퍼 대상(허용 항목)이 맞지만 아직 지우기 전이어야 하는 파일 — 거부된 job 이후에도 전부 그대로 */
const ALL_SEEDED = [
  ...MUST_SURVIVE,
  'Windows/Temp/old.tmp',
  'Windows/Temp/sub/deep.tmp',
  'Windows/Temp/fresh.tmp',
  'Windows/Logs/CBS/old.log',
  'Windows/Logs/CBS/new.log',
  'Windows/Logs/CBS/old.txt',
  'Windows/Minidump/m.dmp',
  'Windows/SoftwareDistribution/Download/pkg.bin'
]
const expectUntouched = (): void => {
  for (const rel of ALL_SEEDED) expect(sb.exists(rel), rel).toBe(true)
}

/** 서명이 올바른 job (필드를 바꾸면 그 값으로 다시 서명한다 — 토큰을 아는 공격자 흉내) */
function signed(over: Partial<UnsignedJob> = {}, token = TOKEN): Job {
  const { mac: _mac, ...base } = createJob({
    jobId: JOB_ID,
    itemIds: ['win-system-temp'],
    mode: 'trash',
    acknowledgeCaution: false,
    token,
    now: NOW
  })
  void _mac
  const next: UnsignedJob = { ...base, ...over }
  return { ...next, mac: signJob(next, token) }
}

const writeJob = (value: unknown): void => writeFileSync(jobFile, JSON.stringify(value))
const readResult = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(elevated, RESULT_FILE), 'utf8')) as Record<string, unknown>

const run = (over: Partial<Parameters<typeof runHelper>[0]> = {}) =>
  runHelper({
    jobFile,
    token: TOKEN,
    env: sb.env,
    appPaths: [userData],
    trash: fakeTrash(sb).trash,
    now: () => NOW,
    ...over
  })

describe('job 파일: 변조 거부 (verifyJob)', () => {
  it('올바른 job 은 받아들인다', () => {
    expect(verifyJob(signed(), TOKEN, NOW).ok).toBe(true)
  })

  const rejects = (raw: unknown, reason: JobRejectReason, token = TOKEN, now = NOW): void => {
    const r = verifyJob(raw, token, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  }

  it('서명 후에 항목 ID 를 바꾸면(서명 그대로) 거부', () => {
    rejects({ ...signed(), itemIds: ['win-system-temp', 'win-minidump'] }, 'bad-signature')
  })
  it('서명 후에 모드/경고확인/시간을 바꿔도 거부', () => {
    rejects({ ...signed(), mode: 'permanent' }, 'bad-signature')
    rejects({ ...signed(), acknowledgeCaution: true }, 'bad-signature')
    rejects({ ...signed(), expiresAt: signed().expiresAt + 3_600_000 }, 'bad-signature')
    rejects({ ...signed(), jobId: 'job-87654321' }, 'bad-signature')
  })
  it('토큰 해시를 바꾸거나 다른 토큰으로 만든 job 은 거부', () => {
    rejects({ ...signed(), tokenHash: sha256Hex('evil') }, 'bad-token')
    rejects(signed({}, 'b'.repeat(64)), 'bad-token') // 공격자가 자기 토큰으로 만든 job
  })
  it('경로를 직접 지정하는 필드(paths/path/targets/command …)가 하나라도 있으면 거부', () => {
    for (const extra of [
      { paths: ['C:\\Users\\victim\\Documents'] },
      { path: 'C:\\Windows\\System32' },
      { targets: ['C:\\'] },
      { command: 'del /s /q C:\\*' }
    ]) {
      rejects({ ...signed(), ...extra }, 'extra-fields')
    }
  })
  it('서명이 맞아도 허용 목록 밖의 규칙 ID 는 거부 (토큰을 안다고 가정)', () => {
    for (const id of ['win-user-temp', 'chrome-cache', 'nonexistent-rule', 'win-old']) {
      rejects(signed({ itemIds: [id] }), 'item-not-allowed')
    }
    rejects(signed({ itemIds: ['win-system-temp', 'chrome-cache'] }), 'item-not-allowed')
  })
  it('경로처럼 생긴 항목 ID(.., 구분자, 드라이브)는 구조 검사에서 거부', () => {
    for (const id of [
      '..\\..\\Windows',
      'C:\\Windows',
      'win-system-temp/../x',
      '',
      'WIN-SYSTEM-TEMP'
    ]) {
      rejects(signed({ itemIds: [id] }), 'malformed')
    }
  })
  it('항목이 없거나 너무 많거나 중복이면 거부', () => {
    rejects(signed({ itemIds: [] }), 'malformed')
    rejects(signed({ itemIds: Array.from({ length: 9 }, (_, i) => `rule-${i}`) }), 'malformed')
    rejects(signed({ itemIds: ['win-minidump', 'win-minidump'] }), 'duplicate-items')
  })
  it('만료·미래 시각·너무 긴 유효기간은 거부', () => {
    rejects(signed(), 'expired', TOKEN, NOW + JOB_TTL_MS)
    rejects(signed({ createdAt: NOW + 10 * 60_000, expiresAt: NOW + 12 * 60_000 }), 'not-yet-valid')
    rejects(signed({ expiresAt: NOW + 24 * 3_600_000 }), 'expired')
  })
  it('주의(caution) 항목은 경고 확인 없이는 거부', () => {
    rejects(signed({ itemIds: ['win-update-download'] }), 'caution-not-acknowledged')
    expect(
      verifyJob(signed({ itemIds: ['win-update-download'], acknowledgeCaution: true }), TOKEN, NOW)
        .ok
    ).toBe(true)
  })
  it('구조가 이상한 입력(버전, 배열, 문자열, null)은 거부', () => {
    rejects({ ...signed(), schemaVersion: 2 }, 'malformed')
    rejects([], 'malformed')
    rejects('job', 'malformed')
    rejects(null, 'malformed')
  })
  it('서명 대상 문자열은 항목 순서와 무관하다', () => {
    const a = signed({ itemIds: ['win-minidump', 'win-system-temp'] })
    const { mac: _m, ...u } = a
    void _m
    expect(canonicalJob(u)).toBe(canonicalJob({ ...u, itemIds: [...u.itemIds].reverse() }))
  })
  it('job 스키마에는 경로를 담을 수 있는 필드가 없다', () => {
    expect(Object.keys(jobSchema.shape).sort()).toEqual(
      [
        'acknowledgeCaution',
        'createdAt',
        'expiresAt',
        'itemIds',
        'jobId',
        'mac',
        'mode',
        'schemaVersion',
        'tokenHash'
      ].sort()
    )
  })
})

describe('헬퍼 실행: 변조된 job 파일은 아무것도 지우기 전에 거부된다', () => {
  beforeEach(seed)

  async function expectRejected(reason: string): Promise<void> {
    const out = await run()
    expect(out.exitCode).toBe(2)
    expect(out.reason).toBe(reason)
    const result = readResult()
    expect(result['ok']).toBe(false)
    expect(result['reason']).toBe(reason)
    expectUntouched()
  }

  it('항목 ID 를 추가한 job (재서명 없음) → bad-signature', async () => {
    writeJob({ ...signed(), itemIds: ['win-system-temp', 'win-minidump'] })
    await expectRejected('bad-signature')
  })
  it('모드를 바꾼 job → bad-signature', async () => {
    writeJob({ ...signed(), mode: 'permanent' })
    await expectRejected('bad-signature')
  })
  it('변조된 확인 토큰 해시 → bad-token', async () => {
    writeJob({ ...signed(), tokenHash: sha256Hex('다른 토큰') })
    await expectRejected('bad-token')
  })
  it('다른 토큰으로 만든 job → bad-token', async () => {
    writeJob(signed({}, 'c'.repeat(64)))
    await expectRejected('bad-token')
  })
  it('규칙 밖 항목 ID (서명은 올바름) → item-not-allowed, 일반 임시 폴더도 그대로', async () => {
    writeJob(signed({ itemIds: ['win-user-temp'] }))
    await expectRejected('item-not-allowed')
    writeJob(signed({ itemIds: ['win-system-temp', 'chrome-cache'] }))
    await expectRejected('item-not-allowed')
  })
  it('경로를 직접 지정한 job → extra-fields, 문서 폴더는 그대로', async () => {
    writeJob({ ...signed(), paths: [sb.p('Users', 'tester', 'Documents')] })
    await expectRejected('extra-fields')
    writeJob({ ...signed(), path: sb.p('Windows', 'System32') })
    await expectRejected('extra-fields')
  })
  it('만료된 job → expired', async () => {
    writeJob(signed())
    const out = await run({ now: () => NOW + JOB_TTL_MS + 1 })
    expect(out).toMatchObject({ exitCode: 2, reason: 'expired' })
    expectUntouched()
  })
  it('깨진 JSON, 배열, 너무 큰 파일, 없는 파일 → 거부', async () => {
    writeFileSync(jobFile, '{ not json')
    await expectRejected('malformed')
    writeFileSync(jobFile, '[]')
    await expectRejected('malformed')
    writeFileSync(jobFile, ' '.repeat(MAX_JOB_BYTES + 1))
    await expectRejected('too-large')
    const out = await run({ jobFile: join(elevated, 'nothing.json') })
    expect(out.exitCode).toBe(2)
    expectUntouched()
  })
  it('job 파일 위치/이름이 정해진 곳이 아니면 거부 (임의 위치의 파일을 읽지 않는다)', async () => {
    const other = sb.mkdir('userdata/other')
    writeFileSync(join(other, JOB_FILE), JSON.stringify(signed()))
    expect(await run({ jobFile: join(other, JOB_FILE) })).toMatchObject({
      exitCode: 2,
      reason: 'bad-location'
    })
    writeFileSync(join(elevated, 'evil.json'), JSON.stringify(signed()))
    expect(await run({ jobFile: join(elevated, 'evil.json') })).toMatchObject({
      reason: 'bad-location'
    })
    expectUntouched()
  })
  it('job 파일이 링크로 바뀌어 있으면 읽지 않는다', async () => {
    const real = join(sb.mkdir('userdata/real'), 'job.json')
    writeFileSync(real, JSON.stringify(signed()))
    try {
      symlinkSync(real, jobFile, 'file')
    } catch {
      return // 심볼릭 링크 권한이 없는 환경
    }
    expect(await run()).toMatchObject({ exitCode: 2, reason: 'not-regular-file' })
    expectUntouched()
  })
})

describe('헬퍼 실행: 올바른 job 은 허용 항목만, 규칙 범위 안에서만 지운다', () => {
  beforeEach(seed)

  it('Windows 임시 + CBS 로그: 오래된 파일만 휴지통으로, 나머지는 그대로', async () => {
    writeJob(signed({ itemIds: ['win-system-temp', 'win-cbs-logs'] }))
    const out = await run()
    expect(out.exitCode).toBe(0)

    expect(sb.exists('Windows/Temp/old.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/sub/deep.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/fresh.tmp')).toBe(true) // 1일 미만
    expect(sb.exists('Windows/Temp')).toBe(true) // 규칙 루트 폴더 자체는 유지
    expect(sb.exists('Windows/Logs/CBS/old.log')).toBe(false)
    expect(sb.exists('Windows/Logs/CBS/new.log')).toBe(true)
    expect(sb.exists('Windows/Logs/CBS/old.txt')).toBe(true) // *.log 만
    expect(sb.exists('Windows/Minidump/m.dmp')).toBe(true) // job 에 없는 항목
    expect(sb.exists('Windows/SoftwareDistribution/Download/pkg.bin')).toBe(true)
    for (const rel of MUST_SURVIVE) expect(sb.exists(rel), rel).toBe(true)

    const result = readResult()
    expect(result).toMatchObject({ ok: true, jobId: JOB_ID, cancelled: false })
    const perItem = result['perItem'] as Array<{ itemId: string; deletedFiles: number }>
    expect(perItem.find((i) => i.itemId === 'win-system-temp')?.deletedFiles).toBe(2)
    expect(perItem.find((i) => i.itemId === 'win-cbs-logs')?.deletedFiles).toBe(1)
  })

  it('헬퍼도 자기 로그를 남긴다 (logs/cleanup-*.log)', async () => {
    writeJob(signed())
    await run()
    const logs = readdirSync(join(userData, 'logs')).filter((f) => f.startsWith('cleanup-'))
    expect(logs.length).toBe(1)
    const text = readFileSync(join(userData, 'logs', logs[0] as string), 'utf8')
    expect(text).toContain('win-system-temp')
    expect(text).toContain(`${JOB_ID}-helper`)
  })

  it('주의(caution) 항목은 경고 확인이 있어야 실행된다', async () => {
    writeJob(signed({ itemIds: ['win-update-download'], acknowledgeCaution: true }))
    expect((await run()).exitCode).toBe(0)
    expect(sb.exists('Windows/SoftwareDistribution/Download/pkg.bin')).toBe(false)
    expect(sb.exists('Windows/SoftwareDistribution/Download')).toBe(true)
  })

  it('영구 삭제: 설정이 꺼져 있으면(기본) job 이 요구해도 실행하지 않는다', async () => {
    writeJob(signed({ mode: 'permanent' }))
    const out = await run()
    expect(out).toMatchObject({ exitCode: 4, reason: 'plan-failed' })
    expectUntouched()
  })

  it('영구 삭제: 설정이 켜져 있어도 규칙이 허용하지 않는 항목(minidump)은 실행하지 않는다', async () => {
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, allowPermanentDelete: true })
    )
    writeJob(signed({ itemIds: ['win-minidump'], mode: 'permanent' }))
    expect((await run()).exitCode).toBe(4)
    expectUntouched()
    // 허용 항목(win-system-temp)은 설정이 켜져 있을 때만 영구 삭제된다
    writeJob(signed({ mode: 'permanent' }))
    expect((await run()).exitCode).toBe(0)
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/fresh.tmp')).toBe(true)
  })

  it('헬퍼가 보호 검사를 스스로 한다: 보호 파일 이름은 규칙 안에 있어도 지우지 않는다', async () => {
    sb.write('Windows/Temp/pagefile.sys', 'swap', 30)
    writeJob(signed())
    expect((await run()).exitCode).toBe(0)
    expect(sb.exists('Windows/Temp/pagefile.sys')).toBe(true)
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(false)
    const perItem = readResult()['perItem'] as Array<{
      itemId: string
      skipped: Array<{ reason: string }>
    }>
    expect(perItem[0]?.skipped.some((s) => s.reason === 'safety-denied')).toBe(true)
  })

  it('규칙 폴더 안의 정션(링크)을 따라가지 않는다: 밖의 문서는 그대로', async () => {
    if (!sb.link('Windows/Temp/escape', 'Users/tester/Documents')) return // 링크를 만들 수 없는 환경
    writeJob(signed())
    expect((await run()).exitCode).toBe(0)
    expect(sb.exists('Users/tester/Documents/doc.txt')).toBe(true)
  })

  it('취소 파일(같은 jobId)이 있으면 파일 사이에서 멈춘다. 다른 jobId 의 오래된 취소는 무시한다', async () => {
    for (let i = 0; i < 60; i++) sb.write(`Windows/Temp/many/f${i}.tmp`, 'z', 10)
    writeFileSync(join(elevated, CANCEL_FILE), JSON.stringify({ jobId: 'old-job-00000' }))
    writeJob(signed())
    await run()
    expect(readResult()).toMatchObject({ ok: true, cancelled: false })
    expect(sb.exists('Windows/Temp/many/f59.tmp')).toBe(false)

    for (let i = 0; i < 60; i++) sb.write(`Windows/Temp/more/g${i}.tmp`, 'z', 10)
    writeFileSync(join(elevated, CANCEL_FILE), JSON.stringify({ jobId: JOB_ID }))
    writeJob(signed())
    await run()
    const result = readResult() as { cancelled: boolean; perItem: Array<{ deletedFiles: number }> }
    expect(result.cancelled).toBe(true)
    expect(result.perItem[0]?.deletedFiles).toBeLessThan(60)
  })
})

describe('헬퍼 환경변수 검증 (실행한 쪽이 정한 env 를 믿지 않는다)', () => {
  it('SystemRoot 가 <드라이브>:\\Windows 이면 깨끗한 env 를 만든다', () => {
    const r = verifyHelperEnv({
      SystemRoot: 'c:\\Windows',
      WINDIR: 'C:\\WINDOWS',
      USERPROFILE: 'D:\\evil'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.env['WINDIR']).toBe('C:\\Windows')
      expect(r.env['SYSTEMDRIVE']).toBe('C:')
      expect(r.env['USERPROFILE']).toBe('C:\\Users\\Default') // 입력의 USERPROFILE 은 쓰지 않는다
    }
  })
  it('WINDIR 를 엉뚱한 폴더로 돌린 env 는 거부', () => {
    for (const bad of [
      { SystemRoot: 'C:\\Users\\victim\\Documents' },
      { SystemRoot: 'C:\\Windows\\..\\Users' },
      { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Users\\victim' },
      { SystemRoot: '\\\\server\\share\\Windows' },
      { SystemRoot: 'C:\\Windows\\System32' },
      {}
    ]) {
      expect(verifyHelperEnv(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('허용 목록(adminRules)', () => {
  const json = JSON.parse(
    readFileSync(resolve(process.cwd(), 'resources/cleanup-rules.json'), 'utf8')
  ) as { pathRules: PathRule[] }
  const byId = new Map(json.pathRules.map((r) => [r.id, r]))

  it('규칙 DB(JSON)의 관리자 항목과 어긋나지 않는다', () => {
    for (const spec of ADMIN_ITEMS) {
      const r = byId.get(spec.id)
      expect(r, spec.id).toBeDefined()
      expect(r?.match).toEqual({ kind: 'prefix', pattern: spec.pattern })
      expect(r?.category).toBe(spec.category)
      expect(r?.safety).toBe(spec.safety)
      expect(r?.cleanable).toBe(true)
      expect(r?.cleanup?.mode).toBe('contents')
      expect(r?.cleanup?.requiresAdmin).toBe(true)
      expect(r?.cleanup?.specialAction).toBeUndefined()
      expect(r?.cleanup?.allowPermanent).toBe(spec.allowPermanent)
      expect(r?.cleanup?.minAgeDays).toBe(spec.minAgeDays)
      expect(r?.cleanup?.includeGlobs).toEqual(
        spec.includeGlobs ? [...spec.includeGlobs] : undefined
      )
    }
  })
  it('JSON 에서 파일 삭제형 관리자 항목이 허용 목록에 빠져 있지 않다', () => {
    const ids = json.pathRules
      .filter((r) => r.cleanup?.requiresAdmin && !r.cleanup.specialAction)
      .map((r) => r.id)
      .sort()
    expect(ids).toEqual([...ADMIN_ITEM_IDS].sort())
  })
  it('허용 목록은 모두 %WINDIR% 아래이고, 기존 규칙 검증(보호 경로 포함)을 통과한다', () => {
    for (const spec of ADMIN_ITEMS) expect(spec.pattern.startsWith('%WINDIR%\\')).toBe(true)
    const set = sb.ruleSet(adminPathRules())
    expect(set.issues).toEqual([])
    expect(set.matcher.rules.map((r) => r.rule.id).sort()).toEqual([...ADMIN_ITEM_IDS].sort())
  })
})

describe('UAC 상승 실행 (PowerShell) — 실제 UAC 없이 인자와 종료 코드만 검사', () => {
  type Call = { file: string; args: string[]; env: Record<string, string | undefined> }
  const fakeExec = (
    reply: { code?: number | string; message?: string } | null,
    calls: Call[] = []
  ): ExecFileFn =>
    ((
      file: string,
      args: string[],
      opts: { env: Record<string, string | undefined> },
      cb: (e: unknown) => void
    ) => {
      calls.push({ file, args, env: opts.env })
      cb(
        reply === null
          ? null
          : Object.assign(new Error(reply.message ?? 'fail'), { code: reply.code })
      )
    }) as unknown as ExecFileFn

  const launch = (reply: Parameters<typeof fakeExec>[0], calls: Call[] = []) =>
    createPowerShellElevation(fakeExec(reply, calls)).launch({
      exe: 'C:\\Program Files\\DiskLens\\DiskLens.exe',
      args: ['--cleanup-helper', '--job', 'C:\\Users\\a b\\elevated\\job.json', '--token', TOKEN]
    })

  it('실행 파일/인자는 명령 문자열이 아니라 환경변수로 넘기고, 스크립트는 고정이다', async () => {
    const calls: Call[] = []
    await launch(null, calls)
    const call = calls[0] as Call
    expect(call.file).toBe('powershell.exe')
    const encoded = call.args[call.args.indexOf('-EncodedCommand') + 1] as string
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(ELEVATE_SCRIPT)
    expect(ELEVATE_SCRIPT).not.toContain(TOKEN)
    expect(ELEVATE_SCRIPT).not.toContain('DiskLens.exe')
    expect(call.env['DISKLENS_ELEV_EXE']).toBe('C:\\Program Files\\DiskLens\\DiskLens.exe')
    expect(call.env['DISKLENS_ELEV_ARGS']).toBe(
      `--cleanup-helper --job "C:\\Users\\a b\\elevated\\job.json" --token ${TOKEN}`
    )
    expect(ELEVATE_SCRIPT).toContain('-Verb RunAs')
  })
  it('종료 코드 해석: 0 정상, 1223 거부, 1224 실행 실패, 그 밖의 숫자는 헬퍼의 종료 코드', async () => {
    const expected: Array<[Parameters<typeof fakeExec>[0], ElevationOutcome]> = [
      [null, { kind: 'exited', code: 0 }],
      [{ code: 1223 }, { kind: 'declined' }],
      [{ code: 1224 }, { kind: 'failed', detail: '관리자 권한으로 실행하지 못했습니다.' }],
      [{ code: 2 }, { kind: 'exited', code: 2 }]
    ]
    for (const [reply, outcome] of expected) expect(await launch(reply)).toEqual(outcome)
    const spawnFail = await launch({ code: 'ENOENT', message: 'spawn powershell.exe ENOENT' })
    expect(spawnFail.kind).toBe('failed')
  })
  it('따옴표·제어문자·빈 문자열이 들어간 인자는 실행하지 않는다', async () => {
    expect(() => quoteArg('a"b')).toThrow()
    expect(() => quoteArg('a\nb')).toThrow()
    expect(() => quoteArg('')).toThrow()
    expect(quoteArg('plain')).toBe('plain')
    expect(quoteArg('with space')).toBe('"with space"')
    const calls: Call[] = []
    const port = createPowerShellElevation(fakeExec(null, calls))
    const outcome = await port.launch({ exe: 'x.exe', args: ['--job', 'a" ; calc ; "'] })
    expect(outcome.kind).toBe('failed')
    expect(calls).toHaveLength(0)
  })
})

describe('앱 ↔ 헬퍼 연결 (가짜 UAC 로 헬퍼를 같은 프로세스에서 실행)', () => {
  const userTemp = baseRule({
    id: 'user-temp',
    name: '사용자 임시',
    match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Temp' },
    category: 'temp',
    cleanup: {
      mode: 'contents',
      minAgeDays: 1,
      requiresAdmin: false,
      allowPermanent: true,
      group: '테스트',
      defaultSelected: true
    }
  })
  const customAdmin = baseRule({
    id: 'custom-admin',
    name: '허용 목록에 없는 관리자 항목',
    match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\Foo' },
    cleanup: {
      mode: 'contents',
      requiresAdmin: true,
      allowPermanent: false,
      group: '테스트',
      defaultSelected: false
    }
  })
  let counter = 0
  const newId = (): string => `job-${String(++counter).padStart(8, '0')}`

  /** 헬퍼를 이 프로세스에서 실행하는 가짜 UAC. 받은 실행 인자를 기록한다 */
  function inProcessElevation(
    calls: Array<{ args: readonly string[]; jobText: string }>
  ): ElevationPort {
    return {
      async launch(req) {
        const arg = (flag: string): string => req.args[req.args.indexOf(flag) + 1] as string
        calls.push({ args: req.args, jobText: readFileSync(arg('--job'), 'utf8') })
        const out = await runHelper({
          jobFile: arg('--job'),
          token: arg('--token'),
          env: sb.env,
          appPaths: [userData],
          trash: fakeTrash(sb).trash
        })
        return { kind: 'exited', code: out.exitCode }
      }
    }
  }

  const client = (elevation: ElevationPort, token = TOKEN) =>
    createAdminClient({
      dir: elevated,
      elevation,
      launcher: { exe: 'C:\\app\\DiskLens.exe', baseArgs: [] },
      newToken: () => token
    })

  const setup = (elevation: ElevationPort, rules: PathRule[] = [userTemp, ...adminPathRules()]) =>
    buildEngine(sb, rules, { admin: client(elevation), newId })

  beforeEach(seed)

  it('전체 흐름: 앱이 규칙 ID 만 보내고, 헬퍼가 관리자 항목을 정리한다 (일반 항목은 앱이 직접)', async () => {
    const calls: Array<{ args: readonly string[]; jobText: string }> = []
    const e = setup(inProcessElevation(calls))
    const plan = await e.service.plan(['user-temp', 'win-system-temp'], 'trash')
    expect(plan.requiresAdmin).toBe(true)
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })

    expect(calls).toHaveLength(1) // UAC 는 한 번만
    expect(sb.exists('Users/tester/AppData/Local/Temp/user.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/fresh.tmp')).toBe(true)
    for (const rel of MUST_SURVIVE.filter((p) => !p.includes('Temp/user.tmp'))) {
      expect(sb.exists(rel), rel).toBe(true)
    }
    const admin = result.perItem.find((i) => i.itemId === 'win-system-temp')
    expect(admin?.deletedFiles).toBe(2)
    expect(admin?.freedBytes).toBe(150)
    expect(result.deletedFiles).toBe(3)
    expect(result.error).toBeUndefined()
    expect(e.logger.entries.some((x) => x.op === 'admin' && x.result === 'end')).toBe(true)
    expect(e.history.records[0]?.itemIds).toEqual(['user-temp', 'win-system-temp'])
  })

  it('앱이 헬퍼에 보내는 것: 실행 인자는 모드 없이 job 위치+토큰뿐, job 에는 경로가 없다', async () => {
    const calls: Array<{ args: readonly string[]; jobText: string }> = []
    const e = setup(inProcessElevation(calls))
    const plan = await e.service.plan(['win-system-temp', 'win-minidump'], 'trash')
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    const call = calls[0]
    expect(call?.args).toEqual([
      '--cleanup-helper',
      '--job',
      join(elevated, JOB_FILE),
      '--token',
      TOKEN
    ])
    const job = JSON.parse(call?.jobText ?? '{}') as Record<string, unknown>
    expect(Object.keys(job).sort()).toEqual(Object.keys(jobSchema.shape).sort())
    expect(job['itemIds']).toEqual(['win-system-temp', 'win-minidump'])
    expect(call?.jobText).not.toContain(sb.root)
    expect(call?.jobText.toLowerCase()).not.toContain('windows\\')
    expect(call?.jobText).not.toContain(TOKEN) // 토큰 원문은 job 에 없다 (해시만)
  })

  it('UAC 를 거부하면 관리자 항목만 건너뛰고 앱은 정상, 일반 항목은 그대로 정리된다', async () => {
    let launches = 0
    const declined: ElevationPort = {
      launch: () => {
        launches++
        return Promise.resolve({ kind: 'declined' })
      }
    }
    const e = setup(declined)
    const plan = await e.service.plan(['user-temp', 'win-system-temp', 'win-minidump'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(launches).toBe(1)
    expect(result.error).toBeUndefined()
    expect(result.cancelled).toBe(false)
    for (const id of ['win-system-temp', 'win-minidump']) {
      const item = result.perItem.find((i) => i.itemId === id)
      expect(item?.deletedFiles).toBe(0)
      expect(item?.skipped).toEqual([{ reason: 'admin-declined', count: 1 }])
    }
    expect(result.perItem.find((i) => i.itemId === 'user-temp')?.deletedFiles).toBe(1)
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(true)
    expect(sb.exists('Windows/Minidump/m.dmp')).toBe(true)
    expect(e.logger.entries.some((x) => x.op === 'admin' && x.reason === 'admin-declined')).toBe(
      true
    )
  })

  it('헬퍼 실행 실패/결과 없음/이전 실행의 결과는 "기타 사유 건너뜀"으로 처리하고 아무것도 지우지 않는다', async () => {
    const cases: Array<[string, ElevationPort]> = [
      ['실행 실패', { launch: () => Promise.resolve({ kind: 'failed', detail: '실행 못함' }) }],
      ['결과 없음', { launch: () => Promise.resolve({ kind: 'exited', code: 3 }) }],
      [
        '이전 실행 결과',
        {
          launch: () => {
            writeFileSync(
              join(elevated, RESULT_FILE),
              JSON.stringify({
                schemaVersion: 1,
                jobId: 'previous-job-1',
                ok: true,
                cancelled: false,
                perItem: [
                  { itemId: 'win-system-temp', freedBytes: 999, deletedFiles: 9, skipped: [] }
                ]
              })
            )
            return Promise.resolve({ kind: 'exited', code: 0 })
          }
        }
      ]
    ]
    for (const [name, elevation] of cases) {
      const e = setup(elevation)
      const plan = await e.service.plan(['win-system-temp'], 'trash')
      const result = await e.service.execute({
        planId: plan.planId,
        confirmationId: plan.confirmationId,
        acknowledgeCaution: false
      })
      const item = result.perItem[0]
      expect(item?.freedBytes, name).toBe(0)
      expect(item?.skipped, name).toEqual([{ reason: 'other', count: 1 }])
      expect(sb.exists('Windows/Temp/old.tmp'), name).toBe(true)
    }
  })

  it('헬퍼가 job 을 거부하면(토큰 불일치 등) 앱은 실패로 처리하고 아무것도 지워지지 않는다', async () => {
    // 가짜 UAC 가 다른 토큰으로 헬퍼를 실행 → 헬퍼가 bad-token 으로 거부
    const wrongToken: ElevationPort = {
      async launch(req) {
        const arg = (flag: string): string => req.args[req.args.indexOf(flag) + 1] as string
        const out = await runHelper({
          jobFile: arg('--job'),
          token: 'f'.repeat(64),
          env: sb.env,
          appPaths: [userData],
          trash: fakeTrash(sb).trash
        })
        return { kind: 'exited', code: out.exitCode }
      }
    }
    const e = setup(wrongToken)
    const plan = await e.service.plan(['win-system-temp'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'other', count: 1 }])
    expectUntouched()
    expect(
      e.logger.entries.some((x) => x.reason === 'helper-failed' && /bad-token/.test(x.detail ?? ''))
    ).toBe(true)
  })

  it('헬퍼 결과에 요청하지 않은 항목이 섞여 있어도 무시한다', async () => {
    const forged: ElevationPort = {
      launch: () => {
        writeFileSync(
          join(elevated, RESULT_FILE),
          JSON.stringify({
            schemaVersion: 1,
            jobId: 'job-00000002',
            ok: true,
            cancelled: false,
            perItem: [
              { itemId: 'win-system-temp', freedBytes: 5, deletedFiles: 1, skipped: [] },
              { itemId: 'user-temp', freedBytes: 999_999, deletedFiles: 999, skipped: [] }
            ]
          })
        )
        return Promise.resolve({ kind: 'exited', code: 0 })
      }
    }
    counter = 0
    const e = setup(forged)
    const plan = await e.service.plan(['user-temp', 'win-system-temp'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.freedBytes).toBe(5 + 1) // 헬퍼 5 + 앱이 직접 지운 user.tmp 1바이트
    expect(result.perItem.find((i) => i.itemId === 'user-temp')?.deletedFiles).toBe(1)
  })

  it('허용 목록에 없는 관리자 항목은 헬퍼로 보내지 않는다 (섞여 있으면 관리자 묶음 전체가 실행되지 않는다)', async () => {
    let launches = 0
    const never: ElevationPort = {
      launch: () => {
        launches++
        return Promise.resolve({ kind: 'declined' })
      }
    }
    const e = setup(never, [userTemp, customAdmin, ...adminPathRules()])
    const plan = await e.service.plan(['custom-admin', 'win-system-temp'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(launches).toBe(0)
    for (const item of result.perItem) expect(item.skipped).toEqual([{ reason: 'other', count: 1 }])
    expectUntouched()
  })

  it('헬퍼 포트가 없으면(예: 가짜 드라이브 E2E) 관리자 항목은 건너뜀(admin-declined)이다', async () => {
    const e = buildEngine(sb, [userTemp, ...adminPathRules()], { newId })
    const plan = await e.service.plan(['win-system-temp'], 'trash')
    const result = await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(result.perItem[0]?.skipped).toEqual([{ reason: 'admin-declined', count: 1 }])
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(true)
  })

  it('앱에서 취소하면 헬퍼가 확인하는 취소 파일(jobId)을 남긴다', async () => {
    const port = client({ launch: () => Promise.resolve({ kind: 'declined' }) })
    port.requestCancel('job-cancel-0001')
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(join(elevated, CANCEL_FILE), 'utf8'))).toEqual({
        jobId: 'job-cancel-0001'
      })
    })
  })

  it('앱이 만드는 파일은 임시 파일을 거쳐 덮어쓴다 (남는 .tmp 없음, 삭제 API 없음)', async () => {
    const e = setup({ launch: () => Promise.resolve({ kind: 'declined' }) })
    const plan = await e.service.plan(['win-system-temp'], 'trash')
    await e.service.execute({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      acknowledgeCaution: false
    })
    expect(readdirSync(elevated).sort()).toEqual([JOB_FILE])
    mkdirSync(elevated, { recursive: true })
    expect(existsSync(join(elevated, JOB_FILE))).toBe(true)
  })
})

describe('헬퍼 코드의 정적 규칙', () => {
  const dir = resolve(process.cwd(), 'src/main/helper')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('헬퍼 모듈은 파일 삭제 API 를 직접 호출하지 않는다 (삭제는 Remover → fsPort 한 곳)', () => {
    const DELETE_CALL =
      /\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|trashItem|rimraf|emptyDir|removeSync)\s*\(/
    for (const f of files) {
      expect(DELETE_CALL.test(strip(readFileSync(join(dir, f), 'utf8'))), f).toBe(false)
    }
  })
  it('electron 에 의존하는 것은 진입점(helperMain.ts) 하나뿐이라 나머지는 테스트에서 그대로 돌릴 수 있다', () => {
    const users = files.filter((f) => /from 'electron'/.test(readFileSync(join(dir, f), 'utf8')))
    expect(users).toEqual(['helperMain.ts'])
  })
  it('헬퍼는 사용자 규칙 파일이나 번들 규칙 JSON 을 읽지 않는다 (허용 목록은 코드에 하드코딩)', () => {
    for (const f of files) {
      const text = strip(readFileSync(join(dir, f), 'utf8'))
      expect(text, f).not.toMatch(/user-rules|loadRuleSetFromFiles|cleanup-rules/)
    }
  })
})
