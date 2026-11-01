import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'resources/**',
      'release/**',
      '.electron-dist2/**',
      'build/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md §6: any 사용 금지
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.{ts,mjs}',
      '*.ts',
      '*.mjs'
    ],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // CLAUDE.md §5-3: renderer에서 Node/Electron API 직접 사용 금지
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'fs', 'fs/*', 'path', 'child_process', 'electron', 'os'] }
      ]
    }
  }
)
