import { useEffect, useState } from 'react'
import type { PingResponse, SecurityInfo } from '@shared/ipc'

// 1단계 완료 기준 점검용 패널: IPC 왕복(ping)과 보안 설정 확인.
// 이후 단계에서 제거하거나 설정 화면의 "앱 정보"로 대체한다.
export function Diagnostics() {
  const [ping, setPing] = useState<PingResponse | null>(null)
  const [security, setSecurity] = useState<SecurityInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  // renderer 샌드박스 점검: Node 전역이 보이면 안 된다.
  const nodeVisible = {
    require: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
    process: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'
  }

  useEffect(() => {
    window.api
      .ping({ message: 'hello' })
      .then(setPing)
      .catch((e: unknown) => setError(String(e)))
    window.api
      .getSecurityInfo()
      .then(setSecurity)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <section className="diag" aria-label="진단">
      <h2>진단 (1단계 확인용)</h2>
      {error && <p role="alert">오류: {error}</p>}
      <ul>
        <li>IPC ping: {ping ? `성공 (${ping.echo})` : '대기 중…'}</li>
        <li>
          보안 설정:{' '}
          {security
            ? `contextIsolation=${security.contextIsolation}, nodeIntegration=${security.nodeIntegration}, sandbox=${security.sandbox}`
            : '대기 중…'}
        </li>
        <li>
          renderer에서 require 보임: {String(nodeVisible.require)} / process 보임:{' '}
          {String(nodeVisible.process)}
        </li>
      </ul>
    </section>
  )
}
