import { defineConfig } from '@playwright/test'

// Electron E2E. 반드시 가짜 드라이브(임시 폴더)에서만 실행한다 (tests/e2e/helpers.ts).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']]
})
