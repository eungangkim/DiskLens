/// <reference lib="dom" />
// 설치본(패키징된 앱) 점검: DISKLENS_PACKAGED_EXE 에 DiskLens.exe 경로가 있을 때만 실행한다.
//  - 사용자 데이터는 --user-data-dir 로 임시 폴더에 둔다 (실제 %APPDATA% 를 건드리지 않는다).
//  - 패키징된 앱은 가짜 드라이브를 무시하므로, 실제 레지스트리는 "읽기만" 하고 스캔은 임시 폴더만 대상으로 한다.
//  - 삭제/정리/제거는 실행하지 않는다. 헬퍼는 "거부되어야 하는" job 만 보낸다 (유효한 job 은 실제 시스템 폴더를 지우므로 만들지 않는다).
import { _electron as electron, expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHmac, createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DiskLensApi } from '../../src/shared/ipc.ts'
import { createSandbox } from './helpers.ts'

const EXE = process.env['DISKLENS_PACKAGED_EXE']

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['NODE_OPTIONS']
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DISKLENS_FAKE_DRIVE'] // 패키징된 앱은 어차피 무시한다
  return env
}

test('설치본: 규칙 DB 로딩, 보안 설정, 스캔 워커, 프로그램 목록 읽기', async () => {
  test.skip(!EXE || !existsSync(EXE), 'DISKLENS_PACKAGED_EXE 가 없으면 건너뜀')
  const sb = createSandbox()
  const userData = sb.mkdir('userdata')
  const scanDir = sb.mkdir('scan-target')
  sb.write('scan-target/Temp/a.tmp', 'a'.repeat(3000))
  sb.write('scan-target/Docs/b.txt', 'b'.repeat(1000))
  const app = await electron.launch({
    executablePath: EXE as string,
    args: [`--user-data-dir=${userData}`],
    env: cleanEnv()
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '스캔' }).or(page.locator('.sidebar'))
    ).toBeVisible({
      timeout: 30_000
    })
    const out = await page.evaluate(async (target: string) => {
      const api = (window as unknown as { api: DiskLensApi }).api
      const security = await api.getSecurityInfo()
      const info = await api.app.info()
      const items = await api.cleanup.items()
      const programs = await api.programs.list({ includeSystem: true, refresh: false })
      const set = await api.settings.get()
      let scan: unknown = null
      if (set.ok) {
        const saved = await api.settings.set({ ...set.data, scanRoot: target })
        if (saved.ok) {
          const done = new Promise<{ files: number; rootNodeId: string }>((resolve) => {
            api.scan.onDone((s) => resolve({ files: s.totalFiles, rootNodeId: s.rootNodeId }))
          })
          const started = await api.scan.start()
          if (started.ok) {
            const d = await done
            const kids = await api.scan.getChildren({
              scanId: started.data.scanId,
              nodeId: d.rootNodeId,
              sort: 'size',
              limit: 50,
              offset: 0
            })
            scan = { files: d.files, children: kids.ok ? kids.data.length : -1 }
          }
        }
      }
      return {
        security,
        info: info.ok ? info.data : null,
        itemCount: items.ok ? items.data.length : -1,
        programsOk: programs.ok,
        programCount: programs.ok ? programs.data.length : -1,
        scan
      }
    }, scanDir)
    console.log(JSON.stringify(out))

    expect(out.security).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
    // 규칙 DB 가 resources 폴더에서 로드됨 (내장 규칙이 있고 거부된 규칙이 없다)
    expect(out.info?.ruleCounts.builtin).toBeGreaterThan(50)
    expect(out.info?.ruleIssues).toBe(0)
    expect(out.info?.userDataDir.toLowerCase()).toBe(userData.toLowerCase())
    expect(out.itemCount).toBeGreaterThan(5) // 정리 항목이 규칙 DB 에서 만들어짐
    expect(out.programsOk).toBe(true)
    expect(out.scan).toMatchObject({ files: 2 }) // asar 안의 스캔 워커가 동작
  } finally {
    await app.close()
    sb.dispose()
  }
})

test('설치본의 관리자 헬퍼 모드: 인자 오류와 변조된 job 은 아무것도 지우지 않고 거부된다', async () => {
  test.skip(!EXE || !existsSync(EXE), 'DISKLENS_PACKAGED_EXE 가 없으면 건너뜀')
  const sb = createSandbox()
  try {
    const run = (args: string[]): { status: number | null; stderr: string } => {
      const r = spawnSync(EXE as string, args, {
        env: cleanEnv(),
        encoding: 'utf8',
        timeout: 60_000
      })
      return { status: r.status, stderr: r.stderr }
    }
    // 1) 인자가 올바르지 않다 → 종료 코드 2
    expect(run(['--cleanup-helper']).status).toBe(2)

    // 2) 위치가 elevated 폴더가 아닌 job → 거부 (종료 코드 2)
    const token = 'a'.repeat(64)
    const wrong = sb.write('somewhere/job.json', '{}')
    expect(run(['--cleanup-helper', '--job', wrong, '--token', token]).status).toBe(2)

    // 3) 올바른 위치지만 서명이 틀린 job → 거부 (종료 코드 2), 결과 파일에 거부 사유
    const now = Date.now()
    const body = {
      schemaVersion: 1,
      jobId: 'packaged-check',
      itemIds: ['win-update-download'],
      mode: 'trash',
      acknowledgeCaution: false,
      createdAt: now,
      expiresAt: now + 60_000,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      mac: createHmac('sha256', 'wrong-token').update('x').digest('hex')
    }
    const jobFile = sb.write('userdata/elevated/job.json', JSON.stringify(body))
    const r = run(['--cleanup-helper', '--job', jobFile, '--token', token])
    expect(r.status).toBe(2)
    expect(existsSync(join(sb.root, 'userdata', 'elevated', 'result.json'))).toBe(true)
  } finally {
    sb.dispose()
  }
})
