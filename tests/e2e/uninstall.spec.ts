// 프로그램 제거 E2E: 가짜 드라이브(임시 폴더)의 가짜 레지스트리 + 모의 제거 프로그램(node.exe + 스크립트)만 쓴다.
// 실제 레지스트리나 실제로 설치된 프로그램은 읽지도 실행하지도 않는다.
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { createMockInstall, fakeEntry } from '../fixtures/mockUninstaller.ts'
import { createSandbox, launch } from './helpers.ts'

const rowOf = (page: Page, name: string) => page.locator('tr', { hasText: name })

function setup() {
  const sb = createSandbox()
  const mock = createMockInstall(sb, 'MockApp')
  sb.write('Program Files/MockApp/app.dll', 'dll')
  mock.writeRegistry([
    fakeEntry('MockApp', {
      DisplayName: 'Mock Okay App',
      Publisher: 'Mock Co',
      DisplayVersion: '1.0',
      EstimatedSize: 1024,
      InstallLocation: sb.p('Program Files', 'MockApp'),
      UninstallString: mock.uninstallString()
    }),
    fakeEntry('MockFail', {
      DisplayName: 'Mock Failing App',
      EstimatedSize: 512,
      UninstallString: mock.uninstallString('--exit 1').replace('--key MockApp', '--key MockFail')
    }),
    fakeEntry('NvDrv', {
      DisplayName: 'NVIDIA Graphics Driver 551.23',
      EstimatedSize: 256,
      UninstallString: mock.uninstallString().replace('--key MockApp', '--key NvDrv')
    }),
    fakeEntry('VcRedist', {
      DisplayName: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
      EstimatedSize: 128,
      UninstallString: mock.uninstallString().replace('--key MockApp', '--key VcRedist')
    })
  ])
  return { sb, mock }
}

test('프로그램 제거: protected 비활성, 취소는 아무것도 실행 안 함, 성공/실패/주의 흐름', async () => {
  const { sb, mock } = setup()
  const run = await launch(sb)
  const { page } = run
  try {
    await page
      .getByRole('button', { name: /프로그램/ })
      .first()
      .click()
    await expect(rowOf(page, 'Mock Okay App')).toBeVisible({ timeout: 20_000 })

    // protected: 제거 버튼 비활성
    await expect(
      rowOf(page, 'NVIDIA Graphics Driver').getByTestId('uninstall-button')
    ).toBeDisabled()

    // 취소: 대화상자에서 기본 포커스는 취소, 아무것도 실행되지 않는다
    await rowOf(page, 'Mock Okay App').getByTestId('uninstall-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused()
    await expect(dialog).toContainText('node.exe')
    await dialog.getByRole('button', { name: '취소' }).click()
    await expect(dialog).toBeHidden()
    expect(existsSync(mock.marker)).toBe(false)

    // Esc 로도 취소
    await rowOf(page, 'Mock Okay App').getByTestId('uninstall-button').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(existsSync(mock.marker)).toBe(false)

    // 주의(caution): 확인 체크 전에는 실행 버튼이 비활성
    await rowOf(page, 'Visual C++').getByTestId('uninstall-button').click()
    const caution = page.getByRole('dialog')
    const exec = caution.getByRole('button', { name: '제거 프로그램 실행' })
    await expect(exec).toBeDisabled()
    await caution.getByRole('checkbox').check()
    await expect(exec).toBeEnabled()
    await caution.getByRole('button', { name: '취소' }).click()

    // 실패: 종료 코드 1 → 실패 안내, 목록에는 그대로 남는다
    await rowOf(page, 'Mock Failing App').getByTestId('uninstall-button').click()
    await page.getByRole('dialog').getByRole('button', { name: '제거 프로그램 실행' }).click()
    const result = page.getByTestId('uninstall-result')
    await expect(result).toContainText('오류로 끝났습니다', { timeout: 30_000 })
    await expect(rowOf(page, 'Mock Failing App')).toBeVisible()
    await result.getByRole('button', { name: '닫기' }).click()

    // 성공: 제거 프로그램 실행 → 완료 → 목록에서 사라짐, 설치 폴더는 앱이 지우지 않고 알려 준다
    await rowOf(page, 'Mock Okay App').getByTestId('uninstall-button').click()
    await page.getByRole('dialog').getByRole('button', { name: '제거 프로그램 실행' }).click()
    await expect(page.getByTestId('uninstall-result')).toContainText('Mock Okay App', {
      timeout: 30_000
    })
    await expect(rowOf(page, 'Mock Okay App')).toHaveCount(0)
    await expect(page.getByTestId('uninstall-leftover')).toContainText('MockApp')
    expect(existsSync(mock.marker)).toBe(true)
    expect(sb.exists('Program Files/MockApp/app.dll')).toBe(true) // 앱은 폴더를 지우지 않는다
  } finally {
    await run.close()
    sb.dispose()
  }
})
