// 삭제 요청 경로의 1차 정리/검증 (SAFETY.md §3.2 1~2). 순수 함수: 파일 시스템에 접근하지 않는다.
import { win32 } from 'node:path'

/** Windows 경로 최대 길이(확장 경로 기준). 이보다 긴 요청은 비정상으로 거부한다 */
export const MAX_PATH_LENGTH = 32_767

export type RawPathResult = { ok: true; path: string } | { ok: false; detail: string }

/**
 * 문자열을 "정규화된 드라이브 절대 경로"로 바꾼다. 해석할 수 없거나 의심스러우면 거부한다.
 * - `/` 와 `\` 혼용 통일, `\\?\` 접두사 제거, `.`/`..` 해석 (`<허용루트>\..\Windows` → `C:\Windows`)
 * - 거부: 빈 값/문자열이 아님, 널 문자, 너무 긴 경로, UNC(`\\서버`)·장치(`\\.\`) 경로, 드라이브 절대 경로가 아님,
 *   `:` 로 시작하는 대체 데이터 스트림(`file.txt:stream`), 이름 끝의 `.` 또는 공백(Windows 가 조용히 떼어 내는 우회), 금지 문자
 */
export function sanitizeRawPath(raw: unknown): RawPathResult {
  if (typeof raw !== 'string' || raw.length === 0)
    return { ok: false, detail: '경로가 비어 있습니다.' }
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, detail: '경로가 너무 깁니다.' }
  if (raw.includes('\0')) return { ok: false, detail: '경로에 널 문자가 있습니다.' }

  let p = raw.replace(/\//g, '\\')
  if (/^\\\\\?\\UNC\\/i.test(p)) return { ok: false, detail: '네트워크 경로는 지원하지 않습니다.' }
  if (p.startsWith('\\\\?\\')) p = p.slice(4)
  if (p.startsWith('\\\\')) return { ok: false, detail: 'UNC/장치 경로는 지원하지 않습니다.' }
  if (!/^[a-zA-Z]:\\/.test(p))
    return { ok: false, detail: '드라이브 문자로 시작하는 절대 경로가 아닙니다.' }
  if (p.indexOf(':', 2) !== -1)
    return { ok: false, detail: '대체 데이터 스트림 표기는 지원하지 않습니다.' }
  // 금지 문자: < > " | ? * 와 제어 문자(0x01~0x1f)
  const hasControl = [...p].some((ch) => ch.charCodeAt(0) < 0x20)
  if (hasControl || /[<>"|?*]/.test(p)) {
    return { ok: false, detail: '경로에 사용할 수 없는 문자가 있습니다.' }
  }

  const normalized = win32.normalize(p)
  const rest = normalized.slice(3)
  if (rest.split('\\').some((seg) => seg !== '' && /[. ]$/.test(seg))) {
    return { ok: false, detail: '이름이 점이나 공백으로 끝나는 경로는 지원하지 않습니다.' }
  }
  const trimmed = normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized
  return { ok: true, path: trimmed }
}
