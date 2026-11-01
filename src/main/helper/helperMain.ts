// 관리자 헬퍼 프로세스의 진입점 (`DiskLens.exe --cleanup-helper --job <job.json> --token <토큰>`).
// 창을 만들지 않고, 일을 마치면 바로 종료한다. 인자로 받는 것은 job 파일 위치와 토큰뿐이다 (경로 삭제 요청 없음).
import { app } from 'electron'
import { dirname } from 'node:path'
import { verifyHelperEnv } from './env'
import { runHelper } from './runHelper'
import { createFakeTrash, resolveFakeDrive } from '../devDrive'
import { tmpdir } from 'node:os'

export interface HelperArgs {
  jobFile: string
  token: string
}

/** argv 에서 헬퍼 모드 인자를 읽는다. `--cleanup-helper` 가 없으면 null. 형식이 이상하면 { error } */
export function parseHelperArgs(argv: readonly string[]): HelperArgs | { error: string } | null {
  if (!argv.includes('--cleanup-helper')) return null
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const jobFile = read('--job')
  const token = read('--token')
  if (!jobFile || !token || !/^[0-9a-f]{64}$/.test(token)) {
    return { error: '--job 과 --token 이 올바르지 않습니다.' }
  }
  return { jobFile, token }
}

export async function runHelperMain(
  args: HelperArgs | { error: string },
  trash: (path: string) => Promise<void>
): Promise<void> {
  if ('error' in args) {
    console.error(`[DiskLens helper] ${args.error}`)
    app.exit(2)
    return
  }
  await app.whenReady()

  // 패키징된 앱: 환경변수를 믿지 않고 검증된 값으로 대체한다. 개발 전용 가짜 드라이브는 패키징 시 무시된다.
  let env: Readonly<Record<string, string | undefined>>
  let helperTrash = trash
  try {
    const fake = resolveFakeDrive({
      value: process.env['DISKLENS_FAKE_DRIVE'],
      isPackaged: app.isPackaged,
      tmpDir: tmpdir()
    })
    if (fake) {
      env = fake.env
      helperTrash = createFakeTrash(fake.trashDir) // 가짜 드라이브에서는 실제 휴지통을 쓰지 않는다
    } else {
      const verified = verifyHelperEnv(process.env)
      if (!verified.ok) {
        console.error(`[DiskLens helper] 환경 검증 실패: ${verified.reason}`)
        app.exit(3)
        return
      }
      env = verified.env
    }
  } catch (error) {
    console.error('[DiskLens helper] 가짜 드라이브 설정이 안전 조건을 만족하지 않습니다', error)
    app.exit(3)
    return
  }

  const outcome = await runHelper({
    jobFile: args.jobFile,
    token: args.token,
    env,
    appPaths: [
      dirname(dirname(args.jobFile)),
      ...(app.isPackaged ? [dirname(app.getPath('exe'))] : [])
    ],
    trash: helperTrash
  })
  if (outcome.exitCode !== 0) {
    console.error(`[DiskLens helper] ${outcome.reason ?? ''} ${outcome.message ?? ''}`)
  }
  app.exit(outcome.exitCode)
}
