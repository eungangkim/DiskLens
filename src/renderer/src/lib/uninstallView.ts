import type { InstalledProgram } from '@shared/types'
import type { UninstallBlock, UninstallResult } from '@shared/uninstall'

const BLOCK_REASON: Record<UninstallBlock, string> = {
  protected: '제거 불가: 시스템이나 하드웨어 동작에 꼭 필요한 프로그램입니다',
  'no-command': '제거 불가: 이 프로그램은 제거 명령을 등록하지 않았습니다',
  'unsupported-command': '제거 불가: 제거 명령이 안전하다고 확인되지 않아 실행하지 않습니다'
}

export interface UninstallButtonState {
  disabled: boolean
  title: string | undefined
}

/** [제거] 버튼 상태 (순수 함수). 다른 제거가 진행 중이면 모두 막는다 */
export function uninstallButtonState(
  program: InstalledProgram,
  busy: boolean
): UninstallButtonState {
  if (program.canUninstall === false) {
    return {
      disabled: true,
      title: program.uninstallBlock ? BLOCK_REASON[program.uninstallBlock] : '제거할 수 없습니다'
    }
  }
  if (busy) return { disabled: true, title: '다른 제거가 진행 중입니다' }
  return { disabled: false, title: undefined }
}

/** 결과 안내의 종류(색): 완료+목록에서 사라짐 = 성공, 취소/거부 = 정보, 나머지 = 경고 */
export function resultTone(result: UninstallResult): 'ok' | 'info' | 'warn' {
  if (result.status === 'finished') return result.stillListed === true ? 'warn' : 'ok'
  if (result.status === 'cancelled' || result.status === 'declined') return 'info'
  return 'warn'
}
