import { useState } from 'react'
import type { AppSettings } from '@shared/ipc'
import { Diagnostics } from '../Diagnostics'
import { useSettingsStore } from '../store/settingsStore'

const THEMES: Array<{ id: AppSettings['theme']; label: string }> = [
  { id: 'system', label: '시스템 설정 따르기' },
  { id: 'light', label: '라이트' },
  { id: 'dark', label: '다크' }
]

/** 설정 화면 (UI_SPEC §7). 모든 값은 저장할 때 main 이 다시 검증한다 */
export function SettingsScreen() {
  const settings = useSettingsStore((s) => s.settings)
  const info = useSettingsStore((s) => s.info)
  const error = useSettingsStore((s) => s.error)
  const update = useSettingsStore((s) => s.update)
  const clearError = useSettingsStore((s) => s.clearError)
  const [reloadAsk, setReloadAsk] = useState(false)

  const pick = async (purpose: 'scanRoot' | 'exclude'): Promise<void> => {
    clearError()
    const r = await window.api.settings.pickFolder({ purpose })
    if (!r.ok) {
      useSettingsStore.setState({ error: r.message })
      return
    }
    if (r.data === null) return
    if (purpose === 'scanRoot') await update({ scanRoot: r.data })
    else if (!settings.excludePaths.some((p) => p.toLowerCase() === r.data?.toLowerCase()))
      await update({ excludePaths: [...settings.excludePaths, r.data] })
  }

  return (
    <div className="settings">
      <h1>설정</h1>
      {error && (
        <p className="notice-line warn" role="alert" data-testid="settings-error">
          {error}{' '}
          <button type="button" className="btn small" onClick={clearError}>
            닫기
          </button>
        </p>
      )}

      <fieldset className="settings-group">
        <legend>스캔</legend>
        <p>
          스캔 루트: <strong data-testid="scan-root">{settings.scanRoot ?? 'C:\\ (기본)'}</strong>
        </p>
        <div className="detail-actions">
          <button type="button" className="btn" onClick={() => void pick('scanRoot')}>
            폴더 선택…
          </button>
          <button
            type="button"
            className="btn"
            disabled={settings.scanRoot === null}
            onClick={() => void update({ scanRoot: null })}
          >
            기본값(C:\)으로
          </button>
        </div>
        <p className="muted small">바꾼 뒤에는 스캔 화면에서 다시 스캔해야 반영됩니다.</p>

        <h3>제외 폴더</h3>
        {settings.excludePaths.length === 0 ? (
          <p className="muted">제외한 폴더가 없습니다.</p>
        ) : (
          <ul className="confirm-items" data-testid="exclude-list">
            {settings.excludePaths.map((p) => (
              <li key={p}>
                <span className="path-break">{p}</span>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`${p} 제외 해제`}
                  onClick={() =>
                    void update({ excludePaths: settings.excludePaths.filter((x) => x !== p) })
                  }
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn" onClick={() => void pick('exclude')}>
          제외 폴더 추가…
        </button>
        <p className="muted small">
          제외한 폴더는 용량 집계에 포함되지 않아 탐색기 속성 값보다 작게 나옵니다. 제외는 스캔에만
          적용되며 삭제 안전 검사와는 관계없습니다.
        </p>
      </fieldset>

      <fieldset className="settings-group">
        <legend>용량 단위</legend>
        <label className="check">
          <input
            type="radio"
            name="size-unit"
            checked={settings.sizeUnit === 'GiB'}
            onChange={() => void update({ sizeUnit: 'GiB' })}
          />
          GiB (1024 기준, 탐색기와 같은 방식)
        </label>
        <label className="check">
          <input
            type="radio"
            name="size-unit"
            checked={settings.sizeUnit === 'GB'}
            onChange={() => void update({ sizeUnit: 'GB' })}
          />
          GB (1000 기준)
        </label>
      </fieldset>

      <fieldset className="settings-group">
        <legend>테마</legend>
        {THEMES.map((t) => (
          <label key={t.id} className="check">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === t.id}
              onChange={() => void update({ theme: t.id })}
            />
            {t.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="settings-group">
        <legend>삭제 방식</legend>
        <label className="check">
          <input
            type="radio"
            name="delete-mode"
            checked={!settings.allowPermanentDelete}
            onChange={() => void update({ allowPermanentDelete: false })}
          />
          항상 휴지통으로 이동 (기본)
        </label>
        <label className="check">
          <input
            type="radio"
            name="delete-mode"
            checked={settings.allowPermanentDelete}
            onChange={() => void update({ allowPermanentDelete: true })}
          />
          임시·캐시 항목에 한해 영구 삭제 허용
        </label>
        {settings.allowPermanentDelete && (
          <p className="confirm-danger" role="note">
            영구 삭제한 파일은 휴지통에서도 복구할 수 없습니다. 정리할 때마다 확인 대화상자에서 다시
            한 번 확인합니다. 로그·덤프 등 임시·캐시가 아닌 항목은 계속 휴지통으로만 이동합니다.
          </p>
        )}
      </fieldset>

      <fieldset className="settings-group">
        <legend>규칙</legend>
        <p>
          규칙 버전: <strong>{info?.rulesVersion ?? '—'}</strong> (내장{' '}
          {info?.ruleCounts.builtin ?? 0}개 · 사용자 {info?.ruleCounts.user ?? 0}개
          {info && info.ruleIssues > 0 ? ` · 거부된 규칙 ${info.ruleIssues}개` : ''})
        </p>
        <p className="path-break" data-testid="user-rules-path">
          사용자 규칙 파일: {info?.userRulesPath ?? '—'}
          {info && !info.userRulesExists ? ' (아직 없음 — 직접 만들어 넣으면 됩니다)' : ''}
        </p>
        {reloadAsk ? (
          <p role="alert">
            사용자 규칙을 다시 읽으려면 앱이 다시 시작됩니다. 진행 중인 스캔·정리는 중단됩니다.{' '}
            <button
              type="button"
              className="btn primary small"
              onClick={() => void window.api.app.reloadRules()}
            >
              다시 시작
            </button>{' '}
            <button type="button" className="btn small" onClick={() => setReloadAsk(false)}>
              취소
            </button>
          </p>
        ) : (
          <button type="button" className="btn" onClick={() => setReloadAsk(true)}>
            규칙 다시 불러오기
          </button>
        )}
      </fieldset>

      <fieldset className="settings-group">
        <legend>앱 정보</legend>
        <p>버전: {info?.version ?? '—'}</p>
        <div className="detail-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void window.api.app.openFolder({ target: 'logs' })}
          >
            로그 폴더 열기
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.api.app.openFolder({ target: 'userData' })}
          >
            사용자 데이터 폴더 열기
          </button>
        </div>
        <p className="muted">이 앱은 인터넷에 연결하지 않습니다.</p>
      </fieldset>
      <Diagnostics />
    </div>
  )
}
