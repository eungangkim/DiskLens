import type { PathRule } from '../../src/shared/rules.ts'

/** 실제 PC와 무관하게 고정된 가짜 환경 (사용자 이름 'tester') */
export const TEST_ENV = {
  SYSTEMDRIVE: 'C:',
  WINDIR: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\tester',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'
}

/** 모든 검증을 통과하는 기본 규칙. 테스트마다 한 가지만 바꿔서 그 규칙만 위반하게 만든다 */
export function rule(over: Partial<PathRule> = {}): PathRule {
  return {
    id: 'test-cache',
    name: '테스트 캐시',
    match: { kind: 'prefix', pattern: '%LOCALAPPDATA%\\TestApp\\Cache' },
    category: 'cache',
    safety: 'safe',
    description: '테스트용 캐시입니다.',
    impact: '다시 만들어집니다.',
    cleanable: true,
    cleanup: {
      mode: 'contents',
      requiresAdmin: false,
      allowPermanent: false,
      group: '테스트',
      defaultSelected: false
    },
    ...over
  }
}

/** cleanup 이 없는 표시 전용 규칙으로 만든다 */
export function withoutCleanup(r: PathRule): PathRule {
  const copy = { ...r }
  delete copy.cleanup
  return copy
}
