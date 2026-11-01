// 프로그램 제거 공용 타입 (ARCHITECTURE.md §6 programs:uninstall*, SAFETY.md §6).
// renderer 는 제거 명령(UninstallString)을 받지 않는다: programId 만 보내고, main 이 레지스트리 값을 다시 찾아 실행한다.

/** 제거 버튼을 쓸 수 없는 이유 (목록 표시용) */
export type UninstallBlock =
  | 'protected' // 제거 불가로 분류된 프로그램 (드라이버, 보안 핵심 구성요소 등)
  | 'no-command' // 레지스트리에 UninstallString 이 없음
  | 'unsupported-command' // 형식이 이상하거나 안전하게 실행할 수 없는 명령

export interface UninstallPlan {
  programId: string
  name: string
  publisher?: string
  version?: string
  sizeBytes?: number
  /** protected 는 계획 단계에서 거부되므로 여기에 오지 않는다 */
  safety: 'safe' | 'caution' | 'unknown'
  /** caution 문구 등 (확인 대화상자에 그대로 보여 준다) */
  warnings: string[]
  needsCautionAck: boolean
  /** Windows Installer(msiexec) 인지, 프로그램 자체의 제거 프로그램인지 */
  installerKind: 'msi' | 'exe'
  /** 화면 표시용 이름 (예: unins000.exe). 전체 명령줄은 보내지 않는다 */
  installerName: string
  /** 일회용·짧은 TTL·이 제거 명령에 묶인 확인 토큰 */
  confirmationId: string
  expiresAt: string
}

export type UninstallStatus =
  | 'finished' // 제거 프로그램이 정상 종료됨 (종료 코드 0, 재부팅 필요 포함)
  | 'failed' // 실행하지 못했거나 오류 코드로 종료됨
  | 'cancelled' // 제거 프로그램 안에서 사용자가 취소함
  | 'declined' // 관리자 권한 허용을 거부함 (제거를 시작하지 않음)

export interface UninstallResult {
  programId: string
  name: string
  startedAt: string
  finishedAt: string
  status: UninstallStatus
  exitCode?: number
  rebootRequired: boolean
  /** 제거 후 다시 읽은 목록에 아직 있는지. 목록을 다시 읽지 못하면 null */
  stillListed: boolean | null
  /** 쉬운 말 설명 */
  message: string
  /** 설치 폴더가 아직 남아 있으면 알려 준다 (보여주기만 한다. 지우지 않는다) */
  leftover?: { path: string; scanNode?: { scanId: string; nodeId: string } }
}
