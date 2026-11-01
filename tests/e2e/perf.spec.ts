// 성능 점검(수동 실행용): 실제 C: 스캔 캐시(scan:cli --save-cache 로 만든 파일)를 가짜 드라이브 앱에 불러와
// 큰 결과에서도 트리/Top 목록이 빠르게 뜨고 화면의 행 수가 제한(가상 스크롤)되는지 잰다.
// 환경변수 DISKLENS_PERF_CACHE 에 캐시 폴더가 없으면 건너뛴다. 캐시 파일은 복사만 하고 원본/실제 파일은 건드리지 않는다.
import { expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, launch } from './helpers.ts'

const CACHE = process.env['DISKLENS_PERF_CACHE']

test('큰 스캔 결과(수백만 파일)에서 트리와 Top 목록이 빠르고 행 수가 제한된다', async () => {
  test.skip(!CACHE || !existsSync(CACHE), 'DISKLENS_PERF_CACHE 가 없으면 건너뜀')
  const sb = createSandbox()
  const userData = sb.mkdir('.e2e-userdata')
  const dest = join(userData, 'scan-cache')
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(CACHE as string))
    copyFileSync(join(CACHE as string, f), join(dest, f))
  const t0 = Date.now()
  const run = await launch(sb, userData)
  const { page } = run
  const times: Record<string, number> = {}
  try {
    // 캐시 로드 → 최상위 폴더가 보일 때까지
    await expect(page.locator('[role="treeitem"]').first()).toBeVisible({ timeout: 60_000 })
    times['캐시 불러오기~트리 표시(ms)'] = Date.now() - t0
    const rows = await page.locator('[role="treeitem"]').count()

    // 큰 폴더 펼치기
    const t1 = Date.now()
    await page.locator('[role="treeitem"]').first().click()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    times['첫 폴더 펼치기(ms)'] = Date.now() - t1

    // Top 100 큰 폴더/파일
    const t2 = Date.now()
    await page.getByRole('tab', { name: /큰 폴더/ }).click()
    await expect(page.locator('.toplist tbody tr').first()).toBeVisible({ timeout: 20_000 })
    times['큰 폴더 Top 표시(ms)'] = Date.now() - t2
    const t3 = Date.now()
    await page.getByRole('tab', { name: /큰 파일/ }).click()
    await expect(page.locator('.toplist tbody tr').first()).toBeVisible({ timeout: 20_000 })
    times['큰 파일 Top 표시(ms)'] = Date.now() - t3

    const mem = await run.app.evaluate(() => process.memoryUsage())
    console.log(
      JSON.stringify({
        ...times,
        '트리에 그려진 행 수': rows,
        'main 프로세스 RSS(MiB)': Math.round(mem.rss / 1048576),
        'main heapUsed(MiB)': Math.round(mem.heapUsed / 1048576)
      })
    )
    expect(rows).toBeLessThan(100)
    expect(times['캐시 불러오기~트리 표시(ms)']).toBeLessThan(30_000)
  } finally {
    await run.close()
    sb.dispose()
  }
})
