// 설정·기록 화면 E2E (가짜 드라이브). 테마/단위가 적용·저장되고, 정리 후 기록 화면에 항목별 결과가 남는다.
import { expect, test } from '@playwright/test'
import { createSandbox, launch } from './helpers.ts'

const TEMP = 'Users/tester/AppData/Local/Temp'

test('설정: 테마·단위 적용 후 재시작해도 유지, 영구 삭제 토글, 앱 정보', async () => {
  const sb = createSandbox()
  sb.write(`${TEMP}/old/a.tmp`, 'a'.repeat(4096), 10)
  let run = await launch(sb)
  try {
    await run.page.getByRole('button', { name: /설정/ }).first().click()
    await expect(run.page.getByRole('heading', { name: '설정' })).toBeVisible()
    // 앱 정보: 규칙 버전과 사용자 규칙 경로, 인터넷 미사용 안내
    await expect(run.page.getByTestId('user-rules-path')).toContainText('user-rules.json')
    await expect(run.page.getByText('이 앱은 인터넷에 연결하지 않습니다.')).toBeVisible()

    await run.page.getByRole('radio', { name: '다크' }).click()
    await expect(run.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await run.page.getByRole('radio', { name: /^GB/ }).click()
    await expect(run.page.getByRole('radio', { name: /^GB/ })).toBeChecked()
    await run.page.getByRole('radio', { name: /영구 삭제 허용/ }).click()
    await expect(run.page.getByRole('radio', { name: /영구 삭제 허용/ })).toBeChecked()
    await expect(run.page.getByText('휴지통에서도 복구할 수 없습니다')).toBeVisible()
    // 스캔 루트 선택 대화상자는 가짜 드라이브에서 막혀 있고, 오류는 앱을 멈추지 않고 보여 준다
    await run.page.getByRole('button', { name: '폴더 선택…' }).click()
    await expect(run.page.getByTestId('settings-error')).toBeVisible()

    // 재시작해도 설정이 유지된다 (같은 사용자 데이터 폴더)
    const userData = run.userData
    await run.close()
    run = await launch(sb, userData)
    await run.page.getByRole('button', { name: /설정/ }).first().click()
    await expect(run.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(run.page.getByRole('radio', { name: /^GB/ })).toBeChecked()
    await expect(run.page.getByRole('radio', { name: /영구 삭제 허용/ })).toBeChecked()
  } finally {
    await run.close()
    sb.dispose()
  }
})

test('기록: 처음엔 비어 있고, 정리 후 항목별 결과가 남는다', async () => {
  const sb = createSandbox()
  sb.write(`${TEMP}/old/a.tmp`, 'a'.repeat(4096), 10)
  const run = await launch(sb)
  const { page } = run
  try {
    await page.getByRole('button', { name: /기록/ }).first().click()
    await expect(page.getByTestId('history-empty')).toBeVisible()

    await page.getByRole('button', { name: /정리/ }).first().click()
    await page.getByRole('button', { name: '분석하기' }).click()
    const row = page.locator('[data-item="win-user-temp"]')
    await expect(row.locator('.cleanup-size')).toContainText('개', { timeout: 20_000 })
    await page.getByRole('button', { name: '안전 항목만 선택' }).click()
    await page.getByRole('button', { name: /선택 항목 정리/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: '휴지통으로 이동' }).click()
    await expect(page.getByTestId('cleanup-result')).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: /기록/ }).first().click()
    const hrow = page.getByTestId('history-row')
    await expect(hrow).toHaveCount(1)
    await expect(hrow).toContainText('휴지통')
    await hrow.click()
    await expect(page.getByTestId('history-detail')).toContainText('개')
  } finally {
    await run.close()
    sb.dispose()
  }
})
