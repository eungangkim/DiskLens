import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, launch } from './helpers.ts'

const TEMP = 'Users/tester/AppData/Local/Temp'

test('정리 화면: 분석 → 확인 대화상자(기본 포커스 취소) → 실행 → 결과·기록·로그', async () => {
  const sb = createSandbox()
  sb.write(`${TEMP}/old/a.tmp`, 'a'.repeat(2048), 10)
  sb.write(`${TEMP}/old/b.tmp`, 'b'.repeat(1024), 10)
  sb.write(`${TEMP}/fresh.tmp`, 'new', 0) // 최소 보관 기간(1일) 미만 → 건너뜀
  sb.write('Users/tester/Documents/keep.docx', 'important', 400) // 규칙 밖 → 절대 불변
  const run = await launch(sb)
  const { page } = run
  try {
    // 렌더러는 Node API 를 쓸 수 없다
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      'undefined'
    )
    expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
      'undefined'
    )

    await page.getByRole('button', { name: /정리/ }).first().click()
    await expect(page.getByTestId('cleanup-summary')).toContainText('정리 가능한 항목')

    // 분석(삭제 없음)
    await page.getByRole('button', { name: '분석하기' }).click()
    const row = page.locator('[data-item="win-user-temp"]')
    await expect(row.locator('.cleanup-size')).toContainText('개', { timeout: 20_000 })
    expect(sb.exists(`${TEMP}/old/a.tmp`)).toBe(true)

    // 기본 선택은 안전 + 기본선택 항목, 임시 폴더가 선택돼 있다
    await page.getByRole('button', { name: '안전 항목만 선택' }).click()
    await expect(row.getByRole('checkbox')).toBeChecked()

    // 확인 대화상자: 기본 포커스 = 취소, 영구 삭제는 설정이 꺼져 있어 선택 불가
    await page.getByRole('button', { name: /선택 항목 정리/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused()
    await expect(dialog.getByRole('radio', { name: /영구 삭제/ })).toBeDisabled()

    // 취소하면 파일은 그대로
    await dialog.getByRole('button', { name: '취소' }).click()
    await expect(dialog).toBeHidden()
    expect(sb.exists(`${TEMP}/old/a.tmp`)).toBe(true)

    // 다시 열어 휴지통으로 실행
    await page.getByRole('button', { name: /선택 항목 정리/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: '휴지통으로 이동' }).click()
    await expect(page.getByTestId('cleanup-result')).toBeVisible({ timeout: 30_000 })

    // 오래된 파일은 가짜 휴지통으로, 새 파일/문서는 그대로
    expect(sb.exists(`${TEMP}/old/a.tmp`)).toBe(false)
    expect(sb.exists(`${TEMP}/old/b.tmp`)).toBe(false)
    expect(sb.exists(`${TEMP}/fresh.tmp`)).toBe(true)
    expect(sb.exists('Users/tester/Documents/keep.docx')).toBe(true)
    expect(existsSync(join(sb.root, '.trash'))).toBe(true)
    expect(readdirSync(join(sb.root, '.trash')).length).toBeGreaterThan(0)

    // 기록과 로그 파일
    const history = JSON.parse(readFileSync(join(run.userData, 'cleanup-history.json'), 'utf8'))
    expect(JSON.stringify(history)).toContain('win-user-temp')
    const logs = readdirSync(join(run.userData, 'logs')).filter((f) => f.startsWith('cleanup-'))
    expect(logs.length).toBeGreaterThan(0)
  } finally {
    await run.close()
    sb.dispose()
  }
})

test('영구 삭제: 허용 안 된 항목이 섞이면 선택 불가, 단독이면 "이해했습니다" 체크 전까지 실행 불가', async () => {
  const sb = createSandbox()
  sb.write(`${TEMP}/old/a.tmp`, 'a'.repeat(512), 10)
  const run = await launch(sb)
  const { page } = run
  try {
    await page.getByRole('button', { name: /설정/ }).first().click()
    const allow = page.getByRole('radio', { name: /영구 삭제 허용/ })
    await allow.click() // 설정 저장은 비동기라 check() 대신 click 후 상태를 기다린다
    await expect(allow).toBeChecked()

    await page.getByRole('button', { name: /정리/ }).first().click()
    await page.getByRole('button', { name: '분석하기' }).click()
    const row = page.locator('[data-item="win-user-temp"]')
    await expect(row.locator('.cleanup-size')).toContainText('개', { timeout: 20_000 })
    await page.getByRole('button', { name: '안전 항목만 선택' }).click()
    await page.getByRole('button', { name: /선택 항목 정리/ }).click()

    // 영구 삭제가 허용되지 않는 항목이 섞여 있으면 영구 삭제는 선택할 수 없다 (안전한 쪽)
    const mixed = page.getByRole('dialog')
    await expect(mixed.getByRole('radio', { name: /영구 삭제/ })).toBeDisabled()
    await mixed.getByRole('button', { name: '취소' }).click()

    // 임시 폴더 하나만 선택하면 영구 삭제를 고를 수 있지만, 체크 전에는 실행 버튼이 꺼져 있다
    const labels = await page
      .locator('.cleanup-row input[type=checkbox]:checked')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
    for (const label of labels) {
      if (label !== '사용자 임시 폴더 선택') {
        await page.getByLabel(label, { exact: true }).uncheck()
      }
    }
    await page.getByRole('button', { name: /선택 항목 정리/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: /영구 삭제/ }).check()
    const danger = dialog.getByRole('button', { name: '영구 삭제', exact: true })
    await expect(danger).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /되돌릴 수 없음/ }).check()
    await expect(danger).toBeEnabled()

    // 취소로 닫아 실제로는 지우지 않는다
    await dialog.getByRole('button', { name: '취소' }).click()
    expect(sb.exists(`${TEMP}/old/a.tmp`)).toBe(true)
  } finally {
    await run.close()
    sb.dispose()
  }
})
