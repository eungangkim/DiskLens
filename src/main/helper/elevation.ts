// UAC 상승 실행 포트. 실제 구현은 PowerShell 의 Start-Process -Verb RunAs 를 쓴다 (네이티브 모듈 없음).
// 실행 파일과 인자는 명령 문자열에 끼워 넣지 않고 환경변수로 넘긴다 → 셸 인젝션 여지가 없다. 스크립트는 고정 문자열이다.
import { execFile } from 'node:child_process'

export type ElevationOutcome =
  /** UAC 창에서 사용자가 거부했다 (Win32 오류 1223) */
  | { kind: 'declined' }
  | { kind: 'failed'; detail: string }
  /** 상승된 프로세스가 끝났다 */
  | { kind: 'exited'; code: number }

export interface ElevationRequest {
  exe: string
  args: readonly string[]
}

export interface ElevationPort {
  launch(request: ElevationRequest): Promise<ElevationOutcome>
}

const DECLINED = 1223
const LAUNCH_FAILED = 1224

/** 고정 스크립트. 값은 $env:DISKLENS_ELEV_* 로만 들어온다 */
export const ELEVATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $p = Start-Process -FilePath $env:DISKLENS_ELEV_EXE -ArgumentList $env:DISKLENS_ELEV_ARGS -Verb RunAs -Wait -PassThru',
  '  exit $p.ExitCode',
  '} catch {',
  `  if ($_.Exception.NativeErrorCode -eq ${DECLINED}) { exit ${DECLINED} } else { exit ${LAUNCH_FAILED} }`,
  '}'
].join('\n')

/** 인자 하나를 Start-Process -ArgumentList 문자열용으로 인용한다. 따옴표·제어문자가 있으면 거부한다 */
export function quoteArg(arg: string): string {
  for (let i = 0; i < arg.length; i++) {
    const c = arg.charCodeAt(i)
    if (c < 32 || c === 127 || arg[i] === '"')
      throw new Error('실행 인자에 쓸 수 없는 문자가 있습니다.')
  }
  if (arg.length === 0) throw new Error('빈 실행 인자는 허용되지 않습니다.')
  return /[\s&()^|<>%!;,=']/.test(arg) ? `"${arg}"` : arg
}

export type ExecFileFn = typeof execFile

export function createPowerShellElevation(execFileFn: ExecFileFn = execFile): ElevationPort {
  return {
    launch(request) {
      let argLine: string
      try {
        argLine = request.args.map(quoteArg).join(' ')
        quoteArg(request.exe)
      } catch (error) {
        return Promise.resolve({
          kind: 'failed',
          detail: error instanceof Error ? error.message : '실행 인자 오류'
        })
      }
      const encoded = Buffer.from(ELEVATE_SCRIPT, 'utf16le').toString('base64')
      return new Promise((resolve) => {
        execFileFn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          {
            windowsHide: true,
            env: {
              ...process.env,
              DISKLENS_ELEV_EXE: request.exe,
              DISKLENS_ELEV_ARGS: argLine
            }
          },
          (error) => {
            if (!error) return resolve({ kind: 'exited', code: 0 })
            const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
            if (typeof code !== 'number') {
              return resolve({ kind: 'failed', detail: `PowerShell 실행 실패: ${error.message}` })
            }
            if (code === DECLINED) return resolve({ kind: 'declined' })
            if (code === LAUNCH_FAILED) {
              return resolve({ kind: 'failed', detail: '관리자 권한으로 실행하지 못했습니다.' })
            }
            resolve({ kind: 'exited', code })
          }
        )
      })
    }
  }
}
