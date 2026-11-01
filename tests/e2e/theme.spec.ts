/// <reference lib="dom" />
// 라이트/다크 가독성 점검 (UI_SPEC §10): 모든 화면을 두 테마로 열어 스크린샷을 남기고,
// 화면에 보이는 글자 요소의 대비(WCAG 4.5:1)를 계산해 기준 미달 요소가 없는지 확인한다.
import { expect, test, type Page } from '@playwright/test'
import { createMockInstall, fakeEntry } from '../fixtures/mockUninstaller.ts'
import { createSandbox, launch } from './helpers.ts'

const MENUS = ['스캔', '정리', '프로그램', '기록', '설정']

/** 화면의 글자 요소 중 대비가 4.5 미만인 것을 찾는다 */
async function lowContrast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = (m[1] as string)
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number)
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
    }
    const lum = ([r, g, b]: number[]): number => {
      const f = (v: number): number => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0)
    }
    const bgOf = (el: Element): [number, number, number] => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const [r, g, b, a] = parse(getComputedStyle(e).backgroundColor)
        if (a > 0.5) return [r, g, b]
      }
      const [r, g, b] = parse(getComputedStyle(document.body).backgroundColor)
      return [r, g, b]
    }
    const bad: string[] = []
    const seen = new Set<string>()
    for (const el of document.querySelectorAll('body *')) {
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent?.trim() ?? '')
        .join('')
      if (!text) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden') continue
      const [fr, fg, fb] = parse(style.color)
      const [br, bgc, bb] = bgOf(el)
      const l1 = lum([fr, fg, fb])
      const l2 = lum([br, bgc, bb])
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      const disabled = (el as HTMLButtonElement).disabled === true
      if (ratio < 4.5 && !disabled) {
        const key = `${el.tagName}.${(el as HTMLElement).className}:${ratio.toFixed(2)}`
        if (!seen.has(key)) {
          seen.add(key)
          bad.push(`${key} "${text.slice(0, 30)}"`)
        }
      }
    }
    return bad
  })
}

test('모든 화면이 라이트/다크에서 읽을 수 있다 (대비 4.5:1 이상)', async () => {
  const sb = createSandbox()
  const mock = createMockInstall(sb, 'MockApp')
  mock.writeRegistry([
    fakeEntry('MockApp', { DisplayName: 'Mock App', UninstallString: mock.uninstallString() }),
    fakeEntry('NvDrv', {
      DisplayName: 'NVIDIA Graphics Driver 551.23',
      UninstallString: mock.uninstallString()
    })
  ])
  sb.write('Users/tester/AppData/Local/Temp/a.tmp', 'x'.repeat(2048), 10)
  const run = await launch(sb)
  const { page } = run
  const problems: string[] = []
  try {
    for (const theme of ['라이트', '다크']) {
      await page.getByRole('button', { name: /설정/ }).first().click()
      await page.getByRole('radio', { name: theme }).click()
      await expect(page.getByRole('radio', { name: theme })).toBeChecked()
      for (const menu of MENUS) {
        await page
          .getByRole('button', { name: new RegExp(menu) })
          .first()
          .click()
        await page.waitForTimeout(300)
        await page.screenshot({
          path: `test-results/theme-${theme}-${menu}.png`
        })
        for (const p of await lowContrast(page)) problems.push(`[${theme}/${menu}] ${p}`)
      }
    }
    expect(problems).toEqual([])
  } finally {
    await run.close()
    sb.dispose()
  }
})
