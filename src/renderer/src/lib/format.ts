// UI_SPEC.md §2.2: 용량 단위 표시. 설정(GiB/GB)에서 바꾸면 setDisplayUnit 으로 전체 화면의 기본 단위가 바뀐다.
export type SizeUnit = 'GiB' | 'GB'

let displayUnit: SizeUnit = 'GiB'
export function setDisplayUnit(unit: SizeUnit): void {
  displayUnit = unit
}

export function formatBytes(bytes: number, unit: SizeUnit = displayUnit): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const base = unit === 'GiB' ? 1024 : 1000
  const labels = unit === 'GiB' ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= base && i < labels.length - 1) {
    value /= base
    i++
  }
  return i === 0 ? `${value} B` : `${value.toFixed(1)} ${labels[i]}`
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const p = ratio * 100
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

export function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR')
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}분 ${pad(s % 60)}초` : `${s}초`
}

/** 긴 경로를 앞쪽 일부를 줄여서 표시 (툴팁에는 전체 경로를 쓴다) */
export function shortenPath(path: string, max = 70): string {
  return path.length <= max ? path : '…' + path.slice(path.length - (max - 1))
}

export const TYPE_LABELS: Record<string, string> = {
  video: '영상',
  image: '이미지',
  audio: '오디오',
  archive: '압축파일',
  executable: '실행파일',
  document: '문서',
  code: '코드',
  'disk-image': '디스크 이미지',
  other: '기타'
}

export const SKIP_REASON_LABELS: Record<string, string> = {
  'permission-denied': '권한 없음',
  busy: '사용 중',
  'not-found': '찾을 수 없음',
  other: '기타'
}
