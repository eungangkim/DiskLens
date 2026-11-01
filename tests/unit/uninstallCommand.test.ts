// UninstallString 안전 파서 테스트 (ROADMAP 9단계: 공백/따옴표/인자 주입에 안전).
// 실행하지 않는 순수 함수 테스트다. "파일이 있다"는 가짜 목록으로 흉내 낸다.
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_PROGRAMS,
  parseUninstallCommand,
  type CommandEnv,
  type CommandRejectReason
} from '../../src/main/programs/command.ts'

const GUID = '{4A9B1C2D-0E3F-4A5B-8C7D-9E0F1A2B3C4D}'
const SYS = 'C:\\Windows\\System32'

const FILES = new Set(
  [
    'C:\\Program Files\\App\\unins000.exe',
    'C:\\Program Files (x86)\\Some Tool\\uninstall.exe',
    'C:\\Tools\\un.exe',
    'D:\\Games\\My Game\\uninst.exe',
    'C:\\Users\\tester\\AppData\\Local\\Programs\\App\\Uninstall App.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\powershell.exe',
    'C:\\Windows\\System32\\rundll32.exe',
    'C:\\Windows\\System32\\msiexec.exe',
    'C:\\Windows\\SysWOW64\\msiexec.exe',
    'C:\\Tools\\run.bat',
    'C:\\Tools\\setup.msi',
    // 모호한 경계 테스트: C:\amb.exe 와 C:\amb.exe tail.exe 가 둘 다 존재
    'C:\\amb.exe',
    'C:\\amb.exe tail.exe',
    // CreateProcess 처럼 ".exe" 를 덧붙여 추측하지 않는다: C:\Program.exe 가 있어도 아래 경로는 그대로만 해석된다
    'C:\\Program.exe',
    'C:\\Program Files\\Dup\\u.exe'
  ].map((p) => p.toLowerCase())
)
const env: CommandEnv = { fileExists: (p) => FILES.has(p.toLowerCase()), systemDir: SYS }

const ok = (raw: string) => {
  const r = parseUninstallCommand(raw, env)
  if (!r.ok) throw new Error(`거부됨(${r.reason}): ${raw}`)
  return r.value
}
const rejected = (raw: unknown, reason?: CommandRejectReason): void => {
  const r = parseUninstallCommand(raw, env)
  expect(r.ok, String(raw)).toBe(false)
  if (!r.ok && reason) expect(r.reason, String(raw)).toBe(reason)
}

describe('받아들이는 형태', () => {
  it('따옴표로 묶은 경로 + 인자', () => {
    const v = ok('"C:\\Program Files\\App\\unins000.exe" /SILENT /NORESTART')
    expect(v).toMatchObject({
      kind: 'exe',
      exe: 'C:\\Program Files\\App\\unins000.exe',
      args: ['/SILENT', '/NORESTART'],
      installerName: 'unins000.exe'
    })
  })
  it('인자 없는 명령, 앞뒤 공백', () => {
    expect(ok('  "C:\\Tools\\un.exe"  ').args).toEqual([])
    expect(ok('C:\\Tools\\un.exe').exe).toBe('C:\\Tools\\un.exe')
  })
  it('따옴표 없는 경로에 공백이 있어도 실제 파일 경계가 하나면 받아들인다', () => {
    const v = ok('C:\\Program Files\\App\\unins000.exe /SILENT')
    expect(v.exe).toBe('C:\\Program Files\\App\\unins000.exe')
    expect(v.args).toEqual(['/SILENT'])
    expect(ok('C:\\Program Files (x86)\\Some Tool\\uninstall.exe').args).toEqual([])
  })
  it('다른 드라이브, 사용자 폴더, 공백 있는 파일 이름', () => {
    expect(ok('"D:\\Games\\My Game\\uninst.exe"').exe).toBe('D:\\Games\\My Game\\uninst.exe')
    expect(
      ok('"C:\\Users\\tester\\AppData\\Local\\Programs\\App\\Uninstall App.exe" --uninstall').args
    ).toEqual(['--uninstall'])
  })
  it('인자의 따옴표 묶음은 하나의 인자로 나뉜다 (셸 없이 그대로 전달)', () => {
    const v = ok('"C:\\Tools\\un.exe" /D="C:\\Program Files\\App" "두 단어 인자"')
    expect(v.args).toEqual(['/D=C:\\Program Files\\App', '두 단어 인자'])
  })
  it('Windows Installer: /X{GUID}, /I{GUID} (대소문자, 따옴표, 공백 변형)', () => {
    for (const raw of [
      `MsiExec.exe /X${GUID}`,
      `msiexec /x${GUID}`,
      `msiexec.exe /X ${GUID}`,
      `"msiexec.exe" /I${GUID}`,
      `"C:\\Windows\\System32\\msiexec.exe" /X${GUID}`,
      `C:\\Windows\\SysWOW64\\msiexec.exe /X${GUID.toLowerCase()}`
    ]) {
      const v = ok(raw)
      expect(v.kind, raw).toBe('msi')
      // 실행 파일은 항상 시스템 폴더의 msiexec 로 고정된다
      expect(v.exe, raw).toBe('C:\\Windows\\System32\\msiexec.exe')
      expect(v.args[1], raw).toBe(GUID)
    }
    expect(ok(`msiexec /i${GUID}`).args[0]).toBe('/I')
  })
})

describe('거부: 인자 주입', () => {
  it('셸 연결·리다이렉션·치환 문자가 인자에 있으면 거부', () => {
    for (const bad of [
      '/S & calc.exe',
      '/S && del /s /q C:\\*',
      '/S | more',
      '/S ; calc',
      '/S > C:\\out.txt',
      '/S < C:\\in.txt',
      '/S ^& calc',
      '/S %COMSPEC%',
      '/S !var!',
      '/S `calc`',
      '/S $(calc)',
      '/S *.*',
      '/S ?'
    ]) {
      rejected(`"C:\\Tools\\un.exe" ${bad}`, 'dangerous-args')
      rejected(`C:\\Tools\\un.exe ${bad}`, 'dangerous-args')
    }
  })
  it('줄바꿈·널·제어문자로 명령을 이어 붙이는 시도', () => {
    rejected('"C:\\Tools\\un.exe" /S\r\ncalc.exe', 'control-chars')
    rejected('"C:\\Tools\\un.exe"\n/S', 'control-chars')
    rejected('"C:\\Tools\\un.exe"\0 /S', 'control-chars')
    rejected('"C:\\Tools\\un.exe"\t/S\u0007', 'control-chars')
  })
  it('따옴표 오류: 닫히지 않음, 닫는 따옴표 뒤에 글자 붙음, \\" 이스케이프', () => {
    rejected('"C:\\Tools\\un.exe /S', 'bad-quoting')
    rejected('"C:\\Tools\\un.exe"/S', 'bad-quoting')
    rejected('"C:\\Tools\\un.exe"x', 'bad-quoting')
    rejected('"C:\\Tools\\un.exe" /D="C:\\a b', 'bad-quoting')
    rejected('"C:\\Tools\\un.exe" "a\\" b', 'bad-quoting')
    rejected('"C:\\Tools\\un.exe" "a\\" & calc', 'dangerous-args') // 어느 쪽이든 거부
  })
  it('인자가 너무 많거나 너무 길면 거부', () => {
    rejected(
      `"C:\\Tools\\un.exe" ${Array.from({ length: 17 }, (_, i) => `a${i}`).join(' ')}`,
      'too-many-args'
    )
    rejected(`"C:\\Tools\\un.exe" ${'a'.repeat(600)}`, 'too-long')
    rejected(`"C:\\Tools\\un.exe" ${'a '.repeat(600)}`, 'too-long')
  })
})

describe('거부: 실행 파일', () => {
  it('비어 있거나 문자열이 아님', () => {
    for (const v of ['', '   ', undefined, null, 42, {}, ['C:\\Tools\\un.exe']])
      rejected(v, 'empty')
  })
  it('상대경로·UNC·장치 경로·드라이브 루트', () => {
    rejected('un.exe', 'not-absolute')
    rejected('.\\un.exe', 'not-absolute')
    rejected('"\\\\server\\share\\un.exe"', 'not-absolute')
    rejected('"\\\\?\\C:\\Tools\\un.exe"', 'not-absolute')
    rejected('"\\\\.\\C:\\Tools\\un.exe"', 'not-absolute')
    rejected('"C:un.exe"', 'not-absolute')
    rejected('"C:\\"', 'not-absolute')
    rejected('/usr/bin/uninstall', 'not-absolute')
  })
  it('.. 경로, 환경변수, 대체 스트림, 슬래시, 끝의 점·공백', () => {
    rejected('"C:\\Tools\\..\\Tools\\un.exe"', 'bad-path')
    rejected('"C:\\Tools\\.\\un.exe"', 'bad-path')
    rejected('"%SystemRoot%\\System32\\msiexec.exe"', 'not-absolute')
    rejected('"%ProgramFiles%\\App\\un.exe"', 'not-absolute')
    rejected('"C:\\%TEMP%\\un.exe"', 'bad-path')
    rejected('"C:\\Tools\\un.exe:evil.exe"', 'bad-path')
    rejected('"C:\\Tools/un.exe"', 'bad-path')
    rejected('"C:\\Tools\\\\un.exe"', 'bad-path')
    rejected('"C:\\Tools \\un.exe"', 'bad-path')
    rejected('"C:\\Tools.\\un.exe"', 'bad-path')
    rejected('"C:\\Tools\\un*.exe"', 'bad-path')
  })
  it('.exe 가 아닌 것(.bat/.cmd/.msi/.lnk/.ps1/.vbs/.com) 은 거부', () => {
    for (const f of [
      'run.bat',
      'run.cmd',
      'setup.msi',
      'a.lnk',
      'a.ps1',
      'a.vbs',
      'a.js',
      'a.com',
      'un'
    ]) {
      rejected(`"C:\\Tools\\${f}"`, 'not-exe')
    }
    rejected('C:\\Tools\\run.bat /S', 'not-exe')
  })
  it('셸·스크립트 호스트·시스템 도구는 존재해도 거부 (cmd /c … 같은 우회)', () => {
    rejected('"C:\\Windows\\System32\\cmd.exe" /c del /s /q C:\\Users', 'blocked-program')
    rejected('C:\\Windows\\System32\\cmd.exe /c calc', 'blocked-program')
    rejected('"C:\\Windows\\System32\\powershell.exe" -Command Remove-Item C:\\', 'blocked-program')
    rejected('"C:\\Windows\\System32\\rundll32.exe" shell32.dll,Control_RunDLL', 'blocked-program')
    for (const name of [
      'wscript.exe',
      'cscript.exe',
      'mshta.exe',
      'regsvr32.exe',
      'reg.exe',
      'wmic.exe',
      'certutil.exe'
    ]) {
      expect(BLOCKED_PROGRAMS.has(name), name).toBe(true)
    }
  })
  it('파일이 없으면 거부 (실행 전 존재 확인)', () => {
    rejected('"C:\\Tools\\gone.exe" /S', 'not-found')
    rejected('C:\\Tools\\gone.exe', 'not-found')
    rejected('"C:\\Program Files\\App\\unins000.exe\\evil.exe"', 'not-found')
  })
  it('따옴표 없는 경로에서 .exe 로 끝나는 실제 파일 경계가 둘 이상이면 거부, 따옴표로 정확히 지정하면 허용', () => {
    rejected('C:\\amb.exe tail.exe /S', 'ambiguous')
    expect(ok('"C:\\amb.exe tail.exe" /S').exe).toBe('C:\\amb.exe tail.exe')
    expect(ok('"C:\\amb.exe" tail.exe').args).toEqual(['tail.exe'])
  })
  it('".exe" 를 덧붙여 추측하지 않는다: C:\\Program.exe 가 있어도 C:\\Program Files\\… 는 그 경로 그대로 해석', () => {
    expect(ok('C:\\Program Files\\Dup\\u.exe /S').exe).toBe('C:\\Program Files\\Dup\\u.exe')
    rejected('C:\\Program Files\\Nothing\\x /S') // .exe 로 끝나는 경계가 없으면 거부
  })
  it('너무 긴 명령', () => {
    rejected(`"C:\\${'a'.repeat(1100)}.exe"`, 'too-long')
    rejected(`"C:\\${'a\\'.repeat(130)}x.exe"`, 'bad-path')
  })
})

describe('거부: Windows Installer 변형', () => {
  it('GUID 가 아니거나, 다른 옵션을 덧붙이거나, 다른 명령을 이어 붙이면 거부', () => {
    for (const raw of [
      'msiexec /X',
      'msiexec /X{not-a-guid}',
      `msiexec /X${GUID} /qn`,
      `msiexec /X${GUID} & calc`,
      `msiexec /X${GUID};calc`,
      `msiexec /uninstall ${GUID}`,
      `msiexec /X ${GUID} ${GUID}`,
      `msiexec /A${GUID}`,
      `msiexec /q /X${GUID}`,
      `msiexec /X"${GUID}"`
    ]) {
      rejected(raw, 'bad-msi-args')
    }
  })
  it('msiexec 를 흉내 낸 다른 위치의 파일은 msi 로 취급하지 않는다', () => {
    rejected(`"C:\\Temp\\msiexec.exe" /X${GUID}`, 'not-found') // 일반 exe 경로로 보고 존재 확인에서 걸린다
    rejected(`"C:\\Tools\\msiexec.exe" /X${GUID}`, 'not-found')
  })
})
