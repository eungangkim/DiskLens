// 배포 빌드: electron-builder 로 NSIS 설치 파일 + 포터블을 만든다. (먼저 `electron-vite build` 가 실행되어 있어야 한다: npm run dist 가 순서대로 실행)
// 백신이 node_modules\electron\dist\electron.exe 를 막는 PC 를 위해, Electron 배포판이 풀려 있는 폴더(.electron-dist2 또는
// 환경변수 DISKLENS_ELECTRON_DIST)가 있으면 electron-builder 가 거기서 복사해 쓰게 한다. 없으면 electron-builder 가 알아서 내려받는다.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const local = join(process.cwd(), '.electron-dist2')
const dist =
  process.env['DISKLENS_ELECTRON_DIST'] ?? (existsSync(join(local, 'electron.exe')) ? local : null)
const args = ['electron-builder', '--win', 'nsis', 'portable', '--x64']
if (dist) args.push(`-c.electronDist=${dist}`)
const env = { ...process.env }
delete env['NODE_OPTIONS'] // Electron/NSIS 도구가 --use-system-ca 를 싫어한다
env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false' // 코드 서명 안 함
const r = spawnSync('npx', args, { stdio: 'inherit', shell: true, env })
process.exit(r.status ?? 1)
