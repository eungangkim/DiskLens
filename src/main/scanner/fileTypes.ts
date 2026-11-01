import type { FileType } from '../../shared/types.ts'

const GROUPS: Array<[FileType, string[]]> = [
  ['video', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg']],
  [
    'image',
    ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'psd', 'raw', 'svg', 'ico']
  ],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a']],
  ['archive', ['zip', '7z', 'rar', 'gz', 'tar', 'bz2', 'xz', 'cab', 'tgz']],
  ['executable', ['exe', 'dll', 'msi', 'sys', 'bat', 'cmd', 'com', 'ocx', 'scr']],
  [
    'document',
    ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'hwpx', 'rtf', 'csv', 'md']
  ],
  [
    'code',
    [
      'js',
      'jsx',
      'tsx',
      'json',
      'py',
      'java',
      'c',
      'cpp',
      'h',
      'cs',
      'go',
      'rs',
      'html',
      'css',
      'xml',
      'yml',
      'yaml',
      'map'
    ]
  ],
  ['disk-image', ['iso', 'vhd', 'vhdx', 'vmdk', 'img', 'wim', 'esd', 'bin']]
]

const BY_EXT = new Map<string, FileType>()
for (const [type, exts] of GROUPS) for (const ext of exts) BY_EXT.set(ext, type)

/** 확장자(점 없이, 소문자) → 유형 */
export function classifyExtension(ext: string): FileType {
  return BY_EXT.get(ext) ?? 'other'
}

/** 파일 이름에서 확장자 추출 (점 없이 소문자). 확장자가 없거나 ".gitignore" 같은 점 파일이면 빈 문자열 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}
