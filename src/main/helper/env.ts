// 상승된 헬퍼의 환경변수 검증. 환경변수는 실행한 쪽(일반 권한 프로세스)이 정할 수 있으므로 그대로 믿지 않는다.
// %WINDIR% 가 가짜 폴더(예: 사용자 문서 폴더)를 가리키게 해서 상승 권한으로 엉뚱한 곳을 지우게 하는 공격을 막는다.
// 드라이브 문자만 받아 나머지 경로를 직접 만든다.
import type { RuleEnv } from '../rules/paths.ts'

export type HelperEnvResult =
  { ok: true; env: Record<string, string> } | { ok: false; reason: string }

/** SystemRoot/WINDIR 가 정확히 `<드라이브>:\Windows` 일 때만 받아들여 깨끗한 env 를 만든다 */
export function verifyHelperEnv(source: RuleEnv): HelperEnvResult {
  const pick = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(source)) if (k.toUpperCase() === name) return v
    return undefined
  }
  const root = pick('SYSTEMROOT') ?? pick('WINDIR')
  const windir = pick('WINDIR') ?? root
  const m = root?.match(/^([A-Za-z]):\\Windows\\?$/i)
  if (!root || !windir || !m || windir.toLowerCase() !== root.toLowerCase()) {
    return { ok: false, reason: 'SystemRoot 가 <드라이브>:\\Windows 형태가 아닙니다.' }
  }
  const drive = `${(m[1] as string).toUpperCase()}:`
  const users = `${drive}\\Users`
  return {
    ok: true,
    env: {
      SYSTEMDRIVE: drive,
      WINDIR: `${drive}\\Windows`,
      SYSTEMROOT: `${drive}\\Windows`,
      PROGRAMFILES: `${drive}\\Program Files`,
      'PROGRAMFILES(X86)': `${drive}\\Program Files (x86)`,
      PROGRAMDATA: `${drive}\\ProgramData`,
      USERPROFILE: `${users}\\Default`,
      LOCALAPPDATA: `${users}\\Default\\AppData\\Local`,
      APPDATA: `${users}\\Default\\AppData\\Roaming`
    }
  }
}
