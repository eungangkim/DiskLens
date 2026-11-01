# CLAUDE.md — DiskLens (C드라이브 정리 데스크탑 앱)

이 파일은 Claude Code가 세션을 시작할 때마다 읽는 최우선 규칙 문서입니다.
작업 전에 반드시 이 문서와, 작업과 관련된 `docs/` 문서를 먼저 읽으세요.

> 프로젝트 가칭: **DiskLens** (변경 가능). 개발 전 과정을 Claude Code가 수행한다. 사용자는 비개발 지식이 많지 않을 수 있으므로, 결과 보고는 쉬운 한국어로 한다.

## 1. 프로젝트 한 줄 요약

Windows C드라이브(약 1TB)의 용량을 폴더/파일별로 스캔하고, 각 항목이 **무엇인지(용도 설명)**, **지워도 되는지(안전도)**를 규칙 DB 기반으로 보여주며, 프로그램 제거와 임시파일/캐시 자동정리까지 한 화면에서 처리하는 Electron 데스크탑 앱.

## 2. 확정된 기술 결정 (변경 시 사용자 승인 필요)

| 항목             | 결정                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 대상 OS          | Windows 10/11 (x64) 전용                                                                                            |
| 프레임워크       | Electron + React + TypeScript + Vite                                                                                |
| 스캔 방식        | Node.js 재귀 스캔을 `worker_threads`에서 실행 (1차). 느리면 WizTree CSV 가져오기 또는 네이티브 모듈로 보완 (후순위) |
| 용도 설명/안전도 | **로컬 규칙 DB(JSON)만 사용.** Claude API 등 외부 AI/네트워크 호출 금지                                             |
| 관리자 권한      | 기본은 일반 권한 실행. 시스템 영역 정리가 필요할 때만 UAC로 권한 상승                                               |
| 삭제 방식        | 기본은 **휴지통 이동**. 영구 삭제는 "임시파일/캐시" 카테고리에 한해서만 허용                                        |
| 프로그램 제거    | 레지스트리의 `UninstallString`으로 해당 프로그램의 공식 제거 프로그램 실행. 강제 삭제 기능 없음                     |
| 배포             | `electron-builder`로 NSIS 설치 파일(.exe) 생성 + 포터블 빌드                                                        |
| 패키지 매니저    | npm                                                                                                                 |
| 테스트           | Vitest(단위), Playwright(Electron E2E)                                                                              |

## 3. 문서 목록 (docs/ 폴더)

작업 종류별로 읽어야 할 문서:

| 문서                           | 언제 읽나                                          |
| ------------------------------ | -------------------------------------------------- |
| `docs/PRD.md`                  | 기능 구현 전. 요구사항과 완료 조건                 |
| `docs/SAFETY.md`               | **삭제/정리/제거 관련 코드를 쓰기 전 반드시.**     |
| `docs/ARCHITECTURE.md`         | 프로세스 구조, IPC, 폴더 구조 관련 작업            |
| `docs/DATA_SPEC.md`            | 스캔 결과, 규칙 DB, 프로그램 목록 데이터 형식 작업 |
| `docs/UI_SPEC.md`              | 화면 구현                                          |
| `docs/ROADMAP.md`              | 다음에 무엇을 할지 정할 때. 단계 순서를 지킨다     |
| `docs/PRD_CHECKLIST.md`        | PRD 완료 조건 점검표 (통과/미통과, 10단계 결과)    |
| `docs/TEST_PLAN.md`            | 테스트 작성/실행                                   |
| `resources/cleanup-rules.json` | 규칙 DB 시드 (DATA_SPEC.md 형식을 따른다)          |

## 4. 폴더 구조 (목표)

```
disklens/
├─ CLAUDE.md
├─ docs/                      # 위 문서들
├─ resources/
│  └─ cleanup-rules.json      # 규칙 DB 시드
├─ src/
│  ├─ main/                   # Electron main 프로세스 (파일/레지스트리/삭제 등 권한 작업)
│  │  ├─ ipc/                 # IPC 핸들러 (채널별 파일)
│  │  ├─ scanner/             # 스캔 워커와 관리자
│  │  ├─ rules/               # 규칙 DB 로더/매처
│  │  ├─ programs/            # 설치 프로그램 목록/제거
│  │  ├─ cleaner/             # 정리(삭제) 로직 — SAFETY.md 준수
│  │  └─ safety/              # 보호 경로 검사 (단일 관문)
│  ├─ preload/                # contextBridge API 정의
│  ├─ renderer/               # React UI
│  └─ shared/                 # main/renderer 공용 타입, IPC 채널 이름
├─ tests/
│  ├─ unit/
│  ├─ e2e/
│  └─ fixtures/               # 테스트용 가짜 폴더 생성 스크립트
├─ electron-builder.yml
└─ package.json
```

## 5. 절대 규칙 (Never)

1. **삭제 코드는 반드시 `src/main/safety/` 의 보호 경로 검사를 통과해야 한다.** 이 검사를 우회하는 삭제 경로를 만들지 않는다.
2. **개발/테스트 중에 사용자의 실제 시스템 파일을 삭제하지 않는다.** 삭제 테스트는 `tests/fixtures/`가 만드는 임시 폴더에서만 한다. 실제 C드라이브 경로에 대해 삭제 코드를 실행하는 테스트 금지.
3. renderer 프로세스에서 Node API(`fs`, `child_process` 등)를 직접 쓰지 않는다. `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` 유지. 모든 시스템 접근은 preload가 노출한 IPC API로만.
4. 외부 네트워크 호출, 텔레메트리, 원격 스크립트 로딩 금지. 앱은 완전 오프라인으로 동작한다.
5. 스캔을 main 프로세스의 메인 스레드나 renderer에서 돌리지 않는다. 반드시 worker.
6. 파일 수십만 개의 목록을 IPC로 한 번에 보내지 않는다. 폴더 단위 집계 + 요청 시 하위 로드 (ARCHITECTURE.md 참고).
7. 사용자 확인 없이 삭제/제거를 실행하는 코드를 만들지 않는다 (자동정리도 "실행" 버튼 + 확인 단계가 필요).
8. 심볼릭 링크/정션(reparse point)을 따라가며 스캔하지 않는다.
9. 레지스트리 쓰기 금지. 레지스트리는 읽기 전용으로만 사용한다.
10. 규칙 DB에서 `safety: "protected"`인 항목은 UI에서도 삭제/정리 버튼을 비활성화한다.

## 6. 코딩 규칙

- TypeScript `strict: true`. `any` 사용 금지 (불가피하면 주석으로 이유 명시).
- IPC 채널 이름과 payload 타입은 `src/shared/`에 한 곳에서만 정의하고 main/preload/renderer가 공유한다.
- 모든 IPC 핸들러는 입력값을 검증한다 (경로는 정규화 후 보호 경로 검사).
- 파일 경로는 `path` 모듈로 다루고, 비교는 대소문자 무시(Windows)로 한다. 환경변수(`%LOCALAPPDATA%` 등)는 규칙 DB 로딩 시 실제 경로로 확장한다.
- 에러는 삼키지 않는다. 권한 오류(EPERM/EACCES)는 "건너뜀"으로 집계하여 UI에 표시한다.
- 함수는 작게, 한 가지 일만. 삭제/제거 같은 위험 로직은 순수 함수(판정)와 부수효과 함수(실행)를 분리해 판정부를 단위 테스트한다.
- 주석과 UI 문구는 한국어. 코드 식별자는 영어.
- 커밋 메시지는 한국어 또는 영어, 한 커밋은 한 가지 변경.

## 7. 자주 쓰는 명령어

```bash
npm install            # 의존성 설치
npm run dev            # 개발 모드 실행 (Electron + Vite)
npm run build          # 프로덕션 빌드
npm run typecheck      # 타입 검사
npm run lint           # 린트
npm test               # 단위 테스트 (Vitest)
npm run test:e2e       # E2E 테스트 (Playwright)
npm run dist           # 설치 파일 + 포터블 생성 (electron-builder)
```

위 스크립트는 프로젝트 초기 세팅(ROADMAP 1단계)에서 `package.json`에 만든다. 실제 이름이 다르면 이 섹션을 갱신한다.

> 현재 상태(11단계 완료: `npm run dist` 로 설치 파일·포터블 생성, README, 설치본 점검 — 포터블은 이 PC에서 실행 실패 조사 중): `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `scan:cli`(`npm run scan:cli -- <경로>`, 읽기 전용 스캔 도구), `rules:report`(`npm run rules:report -- <경로> [--cache <폴더>]`, 규칙에 안 걸린 큰 폴더 보고서), `programs:report`(`npm run programs:report -- [--cache <폴더>] [--top 10] [--out <파일>]`, 설치 프로그램 개수와 큰 프로그램 보고서)가 존재한다. `test:e2e`(`electron-vite build` 후 Playwright, 가짜 드라이브 `DISKLENS_FAKE_DRIVE`에서만 실행. 백신이 `node_moduleselectrondistelectron.exe`를 막으면 `.electron-dist2`에 Electron zip을 풀어 쓴다 — `DISKLENS_ELECTRON_PATH`로 지정 가능)가 존재한다. `dist`(`electron-vite build` 후 electron-builder, 산출물은 `release/`)가 존재한다. 설치본 점검은 `DISKLENS_PACKAGED_EXE=<DiskLens.exe 경로> npx playwright test tests/e2e/packaged.spec.ts`.

## 8. 작업 방식

- 작업은 `docs/ROADMAP.md`의 **단계 순서**대로 한다. 한 번에 여러 단계를 만들지 않는다.
- 각 단계 끝에: (1) 타입검사/린트/테스트 통과, (2) 완료 기준 체크, (3) 사용자에게 **무엇이 되는지** 쉬운 말로 보고, (4) 다음 단계 진행 여부 확인.
- 요구사항이 모호하거나 문서끼리 충돌하면 임의로 정하지 말고 사용자에게 질문한다. 특히 삭제/권한 관련은 더 안전한 쪽으로 해석한다.
- 문서에 없는 기능을 추가하지 않는다. 필요하면 제안만 하고 승인을 받는다.
- 설계 변경이 생기면 코드와 함께 해당 문서도 갱신한다.
- 새 의존성을 추가할 때는 이유를 한 줄로 보고한다. 네이티브 모듈은 빌드 복잡도가 크므로 사전 승인을 받는다.

## 9. 완료의 정의 (Definition of Done)

한 작업이 끝났다고 말하려면:

1. `npm run typecheck`, `npm run lint`, `npm test`가 통과한다.
2. 해당 기능이 PRD.md의 완료 조건을 충족한다.
3. 삭제/제거 관련이면 SAFETY.md 체크리스트를 모두 만족하고 fixtures 기반 테스트가 있다.
4. UI 변경이면 UI_SPEC.md와 일치하고, 실제로 앱을 띄워 확인했다.
