// 관리자 헬퍼 프로세스 E2E: 실제 Electron 을 `--cleanup-helper` 로 띄운다 (UAC 는 쓰지 않는다).
// 가짜 드라이브(임시 폴더)에서만 실행하며, 일반 권한이어도 샌드박스 안에서는 모두 동작한다.
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJob, sha256Hex } from '../../src/main/helper/job.ts'
import { createSandbox, electronExe, helperEnv, MAIN_ENTRY } from './helpers.ts'

const TOKEN = 'b'.repeat(64)

function runHelperProcess(sandboxRoot: string, args: string[]): number | null {
  const r = spawnSync(electronExe(), [MAIN_ENTRY, '--cleanup-helper', ...args], {
    env: helperEnv(sandboxRoot, join(sandboxRoot, 'userdata')),
    timeout: 60_000,
    windowsHide: true
  })
  return r.status
}

test('헬퍼 프로세스: 올바른 job 은 허용 항목만 정리하고, 변조된 job 은 거부한다', () => {
  const sb = createSandbox()
  try {
    sb.write('Windows/Temp/old.tmp', 'x'.repeat(64), 10)
    sb.write('Windows/Temp/fresh.tmp', 'n', 0)
    sb.write('Windows/System32/keep.dll', 'dll', 400)
    sb.write('Users/tester/Documents/doc.txt', 'important', 400)
    sb.write('Users/tester/AppData/Local/Temp/user.tmp', 'u', 10)
    const dir = sb.mkdir('userdata/elevated')
    const jobFile = join(dir, 'job.json')
    const resultFile = join(dir, 'result.json')
    const now = Date.now()
    const job = createJob({
      jobId: 'e2e-job-00000001',
      itemIds: ['win-system-temp'],
      mode: 'trash',
      acknowledgeCaution: false,
      token: TOKEN,
      now
    })

    // 1) 변조: 경로를 직접 지정하는 필드 → 거부(종료 코드 2), 아무것도 지워지지 않음
    writeFileSync(
      jobFile,
      JSON.stringify({ ...job, paths: [sb.p('Users', 'tester', 'Documents')] })
    )
    expect(runHelperProcess(sb.root, ['--job', jobFile, '--token', TOKEN])).toBe(2)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
      ok: false,
      reason: 'extra-fields'
    })
    // 2) 변조: 규칙 밖 항목 ID (서명은 올바르게 다시 만들어도) → 거부
    const outside = createJob({
      jobId: 'e2e-job-00000002',
      itemIds: ['win-user-temp'],
      mode: 'trash',
      acknowledgeCaution: false,
      token: TOKEN,
      now
    })
    writeFileSync(jobFile, JSON.stringify(outside))
    expect(runHelperProcess(sb.root, ['--job', jobFile, '--token', TOKEN])).toBe(2)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
      reason: 'item-not-allowed'
    })
    // 3) 변조: 토큰 해시 → 거부
    writeFileSync(jobFile, JSON.stringify({ ...job, tokenHash: sha256Hex('다른 토큰') }))
    expect(runHelperProcess(sb.root, ['--job', jobFile, '--token', TOKEN])).toBe(2)
    // 4) 인자가 잘못되면(토큰 형식) 시작하자마자 종료 코드 2
    expect(runHelperProcess(sb.root, ['--job', jobFile, '--token', 'abc'])).toBe(2)

    for (const rel of [
      'Windows/Temp/old.tmp',
      'Windows/Temp/fresh.tmp',
      'Windows/System32/keep.dll',
      'Users/tester/Documents/doc.txt',
      'Users/tester/AppData/Local/Temp/user.tmp'
    ]) {
      expect(sb.exists(rel), `거부된 job 이후에도 ${rel} 은 그대로`).toBe(true)
    }

    // 5) 올바른 job → 종료 코드 0, 오래된 임시 파일만 샌드박스 휴지통으로
    writeFileSync(jobFile, JSON.stringify(job))
    expect(runHelperProcess(sb.root, ['--job', jobFile, '--token', TOKEN])).toBe(0)
    expect(sb.exists('Windows/Temp/old.tmp')).toBe(false)
    expect(sb.exists('Windows/Temp/fresh.tmp')).toBe(true)
    expect(sb.exists('Windows/Temp')).toBe(true)
    for (const rel of [
      'Windows/System32/keep.dll',
      'Users/tester/Documents/doc.txt',
      'Users/tester/AppData/Local/Temp/user.tmp'
    ]) {
      expect(sb.exists(rel), rel).toBe(true)
    }
    expect(readdirSync(join(sb.root, '.trash')).length).toBe(1)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
      ok: true,
      jobId: 'e2e-job-00000001',
      perItem: [{ itemId: 'win-system-temp', deletedFiles: 1 }]
    })
    const logs = readdirSync(join(sb.root, 'userdata', 'logs'))
    expect(logs.some((f) => f.startsWith('cleanup-'))).toBe(true)
    expect(existsSync(jobFile)).toBe(true)
  } finally {
    sb.dispose()
  }
})
