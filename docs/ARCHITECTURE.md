# ARCHITECTURE — 설계 문서

## 1. 개요

Electron 3-프로세스 구조(main / preload / renderer)에 **스캔 전용 worker**와 **관리자 정리 헬퍼**를 더한 구조다.

```
┌──────────────── renderer (React, sandbox, 권한 없음) ────────────────┐
│ UI 상태/렌더링만. 시스템 접근 불가. window.api (preload 노출)만 사용   │
└───────────────▲──────────────────────────────────────────────────────┘
                │ IPC (contextBridge / ipcRenderer.invoke, 이벤트 구독)
┌───────────────┴──────────────────────────────────────────────────────┐
│ preload: 허용된 채널만 노출하는 얇은 API. 검증 로직 없음(타입만)       │
└───────────────▲──────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────────── main (Node, 권한 작업 총괄) ─────────┐
│ ipc/        채널별 핸들러 (입력 검증 + 서비스 호출)                  │
│ scanner/    ScanManager ─ spawn ─▶ scan.worker (worker_threads)      │
│ rules/      규칙 DB 로더·검증·매처                                   │
│ programs/   설치 프로그램 조회(레지스트리 읽기) · 제거 실행          │
│ cleaner/    정리 계획·실행 (SAFETY.md 준수)                          │
│ safety/     보호 경로/삭제 허용 판정 (단일 관문)                     │
│ store/      설정·스캔 캐시·정리 기록 저장                            │
└───────────────┬──────────────────────────────────────────────────────┘
                │ (필요한 정리 항목만, UAC 상승)
┌───────────────▼──────────────────────────────────────────────────────┐
│ elevated helper: 관리자 필요 정리 항목 전용. 자체 재검증             │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. 기술 스택 상세

| 영역            | 선택                                                                                                     | 비고                                   |
| --------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 빌드            | `electron-vite` (또는 Vite + electron-builder 구성)                                                      | main/preload/renderer 각각 번들        |
| UI              | React 18 + TypeScript                                                                                    | 상태관리: Zustand (가볍고 충분)        |
| UI 컴포넌트     | 직접 CSS(CSS Modules) + 가상 스크롤용 `@tanstack/react-virtual`                                          | 무거운 UI 라이브러리는 피함            |
| 스캔            | `worker_threads` + `fs.opendir` / `fs.lstat`                                                             | 병렬도는 CPU 코어 기반으로 제한        |
| 레지스트리 읽기 | 읽기 전용. `reg query` 호출(`child_process.execFile`, `shell: false`) 또는 순수 JS 레지스트리 라이브러리 | 네이티브 모듈이 필요하면 사전 승인     |
| 휴지통          | Electron `shell.trashItem`                                                                               |                                        |
| 검증            | `zod`                                                                                                    | IPC 입력 및 규칙 DB 스키마 검증        |
| 저장소          | JSON 파일 (사용자 데이터 폴더). 스캔 캐시는 크므로 JSON 또는 간단한 바이너리/JSONL                       | SQLite는 필요해질 때만 도입(사전 승인) |
| 로그            | 간단한 파일 로거 (일 단위 파일)                                                                          |                                        |
| 테스트          | Vitest, Playwright(Electron)                                                                             | TEST_PLAN.md                           |
| 배포            | electron-builder (NSIS + portable)                                                                       |                                        |

> 새 라이브러리 추가 시 CLAUDE.md §8 규칙(이유 보고, 네이티브는 사전 승인)을 따른다.

## 3. 보안 설정 (BrowserWindow)

```ts
webPreferences: {
  preload: <path>,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
}
```

- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;` (외부 로드 없음)
- `will-navigate`, `setWindowOpenHandler`로 외부 이동/새 창 차단. 외부 URL 열기는 허용 목록 없이는 하지 않음 (이번 범위에서는 열지 않음).
- 단일 인스턴스 잠금(`requestSingleInstanceLock`).

## 4. 프로세스별 책임

### 4.1 main

- 앱 수명주기, 창 생성, IPC 핸들러 등록.
- 비즈니스 로직은 `ipc/`에 두지 않고 서비스 모듈(`scanner`, `rules`, `programs`, `cleaner`)에 둔다. IPC 핸들러는 얇게: **검증 → 서비스 호출 → 결과 변환**.

### 4.2 preload

- `contextBridge.exposeInMainWorld('api', {...})` 한 곳. 공유 타입(`src/shared/ipc.ts`)에 정의된 메서드만 노출.
- 일반 함수(요청/응답)는 `ipcRenderer.invoke`, 진행 상황 같은 스트림은 구독 함수 `onScanProgress(cb) => unsubscribe` 형태.

### 4.3 renderer

- 화면(UI_SPEC.md), 상태, 필터/정렬(메모리 내 결과 기준), 표시만. 경로 문자열을 만들어 삭제를 직접 요청하지 않는다. 삭제는 **항목 ID(규칙 ID/스캔 노드 ID)** 로 요청하고 main이 경로를 해석한다.

### 4.4 scan worker

- 입력: 루트 경로, 제외 목록, 옵션. 출력: 진행 메시지와 최종 집계 트리.
- 아래 §5 참고.

### 4.5 elevated helper

- 관리자 필요 정리 항목 전용. §7 참고.

## 5. 스캔 설계

### 5.1 알고리즘

- 반복(iterative) 깊이 우선 탐색 + 작업 큐. 재귀 호출 스택 오버플로 방지.
- `fs.opendir`로 디렉터리를 스트리밍하며 열고, 각 엔트리에 `lstat`(링크 따라가지 않음) 호출.
- 디렉터리 엔트리 타입이 reparse point(심볼릭 링크/정션)면 **따라가지 않고** 노드에 `isLink: true`만 기록, 용량 0.
- 에러 처리: EPERM/EACCES/ENOENT/EBUSY는 건너뜀 카운트 + 건너뜀 목록(최대 N개 샘플 + 총 개수)에 기록.
- 파일 크기: 기본 `size`(논리 크기). 선택적으로 클러스터(기본 4096) 단위로 올림한 **디스크 점유 크기**를 계산 가능 (`options.allocatedSize`, 기본 켜짐 권장 — 작은 파일이 많을 때 탐색기 값과 더 근접). 어느 값을 보여줄지는 설정으로 제공(P1).
- 클라우드 플레이스홀더(OneDrive 온라인 전용 등): 파일 속성으로 감지되면 디스크 점유 0 + `cloudOnly: true`.

### 5.2 병렬화

- worker 1개가 전체를 도는 단순 방식으로 시작(ROADMAP 2단계). 느리면 **루트 하위 최상위 폴더들을 worker 풀(코어 수 − 1, 최대 8)에 분배**.
- 각 worker는 자기 서브트리를 집계해 반환, `ScanManager`가 병합.
- 취소: `ScanManager.cancel()`이 모든 worker에 취소 메시지 → 각 worker는 디렉터리 단위로 취소 플래그를 확인하고 즉시 반환 (1초 내 중단).

### 5.3 메모리 절약 (중요)

- **파일 단위 노드를 전부 보관하지 않는다.**
  - 폴더 노드: `{ id, parentId, name, size, fileCount, dirCount, children?: ... }`
  - 파일은 폴더 노드의 "직계 파일 합계(`ownFilesSize`, `ownFileCount`)"로만 집계.
  - 단, **상위 큰 파일 Top-K**(기본 K=500)는 별도 힙으로 유지해 파일 목록을 제공.
- 트리 깊이가 깊은 하위 폴더는 **용량이 작은 것을 접어서(collapse)** 저장: 1MB 미만(`collapseThresholdBytes`)의 폴더는 끝나는 즉시 부모의 "기타 N개 폴더" 합계로 합치고 노드를 버린다(2단계 구현. 부모 비율 기준은 쓰지 않는다). 접힌 폴더는 하위가 모두 더 작으므로 하위 노드도 남지 않는다. 단, 규칙 매칭을 위해 **규칙 경로로 지정된 폴더는 접지 않는다** (스캔 시작 시 규칙 경로 목록을 worker에 전달).
- 확장자별 집계(유형별 요약)는 worker에서 맵으로 누적.

### 5.4 진행/취소 프로토콜

worker → main 메시지:

```ts
{ type: 'progress', filesScanned, bytesScanned, currentPath, skipped }   // ~200ms 간격으로 스로틀
{ type: 'done', result: ScanResultSummary }
{ type: 'error', message }
```

main → renderer: `scan:progress` 이벤트(스로틀 200~500ms).

### 5.5 결과 캐시

- 스캔 완료 시 사용자 데이터 폴더의 `scan-cache/`에 `<드라이브>-slot0~2.json.gz`로 저장한다. 오래된 파일을 지우지 않고 **고정 슬롯 3개를 번갈아 덮어써서** 최근 3개만 유지한다(2단계 구현). 로드는 수정 시각이 가장 최근인 유효한 파일을 쓰고, 깨졌거나 버전이 다르면 다음 후보/없음으로 처리한다.
- 알려진 한계(2단계): Node의 `fs`로는 Windows 파일 속성을 얻을 수 없어 OneDrive 온라인 전용(`cloudOnly`) 판별과 실제 디스크 점유 크기(압축/희소 파일)·하드링크 중복 제거는 하지 못한다. 디스크 점유 크기는 클러스터 올림 근사치다.
- 앱 시작 시 최신 캐시를 로드하여 즉시 표시(“마지막 스캔: …”).

## 6. IPC 계약

채널 이름과 타입은 `src/shared/ipc.ts`에 단일 정의. 아래는 목록(요약). 상세 타입은 DATA_SPEC.md.

| 채널                              | 방향        | 요청                                                  | 응답                             | 설명                                                                 |
| --------------------------------- | ----------- | ----------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `scan:start`                      | R→M         | 없음 (루트는 main이 설정에서 결정. 3단계: 기본 `C:\`) | `{ scanId, root }`               | 스캔 시작. 이미 진행 중이면 `BUSY`                                   |
| `scan:error`                      | M→R(이벤트) | —                                                     | `string`                         | 스캔 실패 메시지                                                     |
| `app:getDriveInfo`                | R→M         | 없음                                                  | `DriveInfo`                      | 상단바 드라이브 용량 막대                                            |
| `shell:copyPath`                  | R→M         | `{ scanId, nodeId }`                                  | `void`                           | 경로를 클립보드에 복사 (main이 ID→경로 해석)                         |
| `scan:cancel`                     | R→M         | `{ scanId }`                                          | `void`                           | 취소                                                                 |
| `scan:progress`                   | M→R(이벤트) | —                                                     | `ScanProgress`                   | 진행                                                                 |
| `scan:done`                       | M→R(이벤트) | —                                                     | `ScanSummary`                    | 완료                                                                 |
| `scan:getChildren`                | R→M         | `{ scanId, nodeId, sort, limit, offset }`             | `NodeView[]`                     | 하위 폴더/파일 요약 (규칙 매칭 포함)                                 |
| `scan:getTop`                     | R→M         | `{ scanId, kind: 'folders'｜'files', limit }`         | `NodeView[]`                     | 상위 큰 항목                                                         |
| `scan:getTypeSummary`             | R→M         | `{ scanId }`                                          | `TypeSummary[]`                  | 유형별 용량                                                          |
| `scan:getSkipped`                 | R→M         | `{ scanId }`                                          | `SkippedItem[]`                  | 건너뜀 목록                                                          |
| `scan:loadCache`                  | R→M         | —                                                     | `ScanSummary｜null`              | 캐시 로드                                                            |
| `rules:describe`                  | R→M         | `{ scanId, nodeIds[] }`                               | `RuleMatch[]`                    | 노드 설명/안전도 (최대 200개)                                        |
| `scan:find`                       | R→M         | `{ scanId, safety, cleanableOnly, query, limit }`     | `NodeView[]`                     | 안전도 필터·"지워도 되는 것만"·이름 검색. 큰 순 평면 목록 (최대 500) |
| `scan:getAncestors`               | R→M         | `{ scanId, nodeId }`                                  | `string[]`                       | 루트부터 해당 폴더까지의 노드 ID (프로그램 → 스캔 트리 위치 펼치기)  |
| `programs:list`                   | R→M         | `{ includeSystem, refresh }`                         | `InstalledProgram[]`             | 설치 프로그램 목록(레지스트리 읽기 전용). 제거 명령은 포함하지 않는다 |
| `programs:openFolder`             | R→M         | `{ programId }`                                      | `void`                           | 설치 폴더를 탐색기에서 열기 (main 이 programId → 경로 해석)          |
| `programs:uninstallPlan`          | R→M         | `{ programId }`                                      | `UninstallPlan`                  | 제거 계획: 이름·설치 프로그램 종류·경고·확인 토큰(5분). 명령줄은 보내지 않는다 |
| `programs:uninstall`              | R→M         | `{ programId, confirmationId, acknowledgeCaution }`   | `{ started: true }`              | 제거 시작(토큰 필수). 끝나면 `programs:uninstallDone` 이벤트로 `UninstallResult` 전달 |
| `programs:uninstallDone`          | M→R (이벤트) | `UninstallResult`                                    | —                                | 제거 프로그램 종료 후 결과(종료 코드, 목록 잔존 여부, 남은 폴더 후보) |
| `cleanup:analyze`                 | R→M         | `{ itemId }`                                          | `CleanupPlanItem`                | 항목 하나의 예상 용량 측정(토큰 없음, 삭제 없음). 7단계에서 추가       |
| `cleanup:plan`                    | R→M         | `{ itemIds[], mode }`                                 | `CleanupPlan`(+`confirmationId`) | 미리보기(삭제 없음)                                                  |
| `cleanup:execute`                 | R→M         | `{ planId, confirmationId, acknowledgeCaution }`      | `{ jobId }`                      | 실행                                                                 |
| `cleanup:cancel`                  | R→M         | `{ jobId }`                                           | `void`                           | 취소                                                                 |
| `cleanup:progress`/`cleanup:done` | M→R         | —                                                     | 진행/결과                        |                                                                      |
| `cleanup:history`                 | R→M         | —                                                     | `CleanupRecord[]`                | 정리 기록                                                            |
| `shell:showInExplorer`            | R→M         | `{ nodeId }`                                          | `void`                           | 탐색기에서 보기 (`shell.showItemInFolder`)                           |
| `settings:get`/`settings:set`     | R→M         | `AppSettings` (set)                                   | `AppSettings`                    | 설정. set 은 strict 스키마 + main 재검증(스캔 루트·제외 폴더는 드라이브 절대경로, 존재 확인). 실패하면 `INVALID_REQUEST` 와 이유 |
| `settings:pickFolder`             | R→M         | `{ purpose: 'scanRoot' \| 'exclude' }`                | `string \| null`                  | main 이 폴더 선택 대화상자를 띄운다 (renderer 는 경로를 만들 수 없다). 가짜 드라이브에서는 거부 |
| `app:info`                        | R→M         |                                                       | `AppInfo`                        | 앱/규칙 버전, 규칙 개수, 사용자 규칙 경로, 로그·사용자 데이터 폴더 경로 |
| `app:openFolder`                  | R→M         | `{ target: 'logs' \| 'userData' }`                    | `null`                           | 정해진 폴더만 탐색기로 연다 (임의 경로 불가)                          |
| `app:reloadRules`                 | R→M         |                                                       | `null`                           | 사용자 규칙을 다시 읽기 위해 앱을 다시 시작한다 (규칙을 쓰는 서비스가 많아 부분 갱신 대신 재시작) |

7단계 추가 사항: `cleanup:execute` 는 `{ jobId }` 만 즉시 반환하고, 진행은 이벤트 `cleanup:progress`, 완료는 `cleanup:done`(CleanupResult)으로 알린다. 설정 `settings.json` 은 현재 `allowPermanentDelete`(기본 false)만 가진다.

개발·E2E 전용 `DISKLENS_FAKE_DRIVE`: `os.tmpdir()` 아래 `disklens-` 로 시작하는 폴더를 가짜 C 드라이브로 쓰고(규칙·보호 경로의 `%WINDIR%` 등을 그 안으로 돌림), 휴지통 대신 그 안의 `.trash` 로 이동한다. 패키징된 앱에서는 무시되며 보호 경로 검사는 꺼지지 않는다.

규칙:

- renderer는 **경로를 직접 보내지 않고 ID**를 보낸다 (`nodeId`, `itemId`, `programId`). main이 ID → 경로를 해석. (경로를 보내야 하는 경우는 스캔 루트 선택 정도이며 그것도 main의 다이얼로그가 반환한 값만 사용)
- 모든 요청 payload는 zod로 검증. 실패 시 `INVALID_REQUEST` 에러.
- 에러 응답 형식 통일: `{ ok: false, code: 'SAFETY_DENIED'｜'NOT_FOUND'｜'PERMISSION'｜'INVALID_REQUEST'｜'BUSY'｜'INTERNAL', message }`. 성공은 `{ ok: true, data }`. (`BUSY`: 이미 진행 중인 작업이 있음. 예상치 못한 내부 오류는 상세 내용을 숨기고 `INTERNAL`로만 알린다.)
- `scan:getChildren` 응답에는 하위 폴더 외에 합성 행이 섞인다: `col:<부모ID>`(기타 N개 폴더), `own:<부모ID>`(바로 아래 파일 합계), 큰 파일은 `f:<번호>`. `shell:*`는 합성 행에서 부모 폴더 경로로 해석한다.
- **개발 모드 전용 시험 설정**(`app.isPackaged`이면 무시): 환경변수 `DISKLENS_SCAN_ROOT`(스캔 루트), `DISKLENS_USER_DATA`(사용자 데이터 폴더). UI 검증을 실제 `C:\` 대신 작은 폴더/격리된 캐시로 하기 위한 것이며 보호 경로·삭제 검사와 무관하다. 6단계 이후 삭제 E2E의 "허용 루트 주입"도 같은 원칙(검사를 끄지 않고 루트만 지정)으로 확장한다.

## 7. 정리(Cleanup) 흐름과 관리자 헬퍼

### 7.1 계획 → 확인 → 실행

```
cleanup:plan(itemIds, mode)
  └ main: 규칙에서 대상 해석 → safety 검사 → 대상 파일 수/용량 계산(삭제 없음)
  └ 결과 CleanupPlan + confirmationId(일회용, 짧은 TTL, plan 내용 해시에 바인딩) 반환
UI: 확인 대화상자 (SAFETY.md §9)
cleanup:execute(planId, confirmationId, acknowledgeCaution)
  └ main: confirmationId 검증(일치/미만료/미사용) → 항목별 실행 → 진행 이벤트
  └ 일반 권한 항목: main이 실행
  └ requiresAdmin 항목: 헬퍼 실행(아래)
  └ 결과 + 로그 기록
```

- `confirmationId`는 `plan` 내용(항목 ID, 대상 수, 모드)에 묶여 있어서, 계획 이후 대상이 바뀌면 무효.
- 실행 직전 main이 **다시 한 번** 각 대상 경로에 safety 검사를 수행 (계획 이후 상태 변화 대비).

### 7.1-1 구현 구조 (6단계, UI/IPC 미연결)

```
safety/rawPath.ts        경로 문자열 검증·정규화 (빈 값/널/길이/UNC/스트림/..)
safety/protectedPaths.ts 하드코딩 보호 구역 + 정리 허용 예외 + 보호 파일 이름
safety/confirmation.ts   ConfirmationStore(일회용·TTL·계획 바인딩) → ExecutionPermit(위조 불가 증표)
safety/deleteGuard.ts    DeleteGuard.check/evaluate, judgeRule — 삭제 허용 판정(읽기 전용)
cleaner/targets.ts       규칙 → 규칙 루트(glob 펼침) → 대상 파일 열거(include/exclude/minAge, 링크 건너뜀)
cleaner/remover.ts       deleteTarget: guard.check → 재확인 → 삭제. 삭제의 유일한 관문
cleaner/fsPort.ts        실제 삭제 API(unlink/rmdir/휴지통)를 호출하는 유일한 파일. 휴지통은 주입(기본값 없음)
cleaner/service.ts       CleanupService: plan → confirmationId → execute / cancel / 진행 / 로그 / 기록
cleaner/log.ts, history.ts  JSONL 로그, cleanup-history.json
```

- **허용 루트 주입**: 보호 경로와 규칙은 환경변수(`env`)로 만들어진다. 프로덕션은 `process.env`, 테스트는 임시 폴더를 "가짜 C 드라이브"로 하는 env를 넘긴다. 보호 검사를 끄는 플래그는 없다.
- **삭제 단위**: 폴더 통째가 아니라 **파일 단위**로 판정·삭제한다(링크는 따라가지 않고 건너뜀). 비게 된 폴더만 마지막에 지운다. 규칙 루트 폴더는 `contents` 모드에서 유지된다. 휴지통 모드도 파일 단위이며, 대량 캐시에서 느릴 수 있어 7단계에서 측정 후 최적화한다.
- **토큰 바인딩**: 토큰은 `planId`와 계획 내용 해시(항목 ID·모드·항목별 대상 수/용량)에 묶인다. 계획 이후 파일이 늘거나 줄어도 실행은 가능하지만, 실행하는 모든 대상은 그 시점에 다시 safety 검사를 통과해야 한다.
- **로그 실패 시 중단**: 로그를 쓸 수 없으면 더 지우지 않고 `CleanupResult.error`로 알린다.
- **전용 동작**: `empty-recycle-bin`, `run-disk-cleanup`은 `SpecialActionPort` 인터페이스만 있다(실제 구현은 이후 단계). 포트가 없으면 건너뜀.
- **관리자 항목**: `requiresAdmin` 항목은 이 프로세스에서 지우지 않는다. 헬퍼 포트(`AdminCleanupPort`)가 있으면 UAC 헬퍼에 규칙 ID만 넘겨 처리하고(§7.2), 포트가 없으면 `admin-declined`로 건너뛴다.
- 삭제 API 호출 위치는 테스트(`deletionIsolation.test.ts`)가 정적으로 검사한다. 7단계에서 `createNodeRemovePort(shell.trashItem)`을 연결하면 이 테스트의 허용 목록을 함께 갱신한다.

### 7.1-2 프로그램 제거 (9단계 구현)

```
src/main/programs/
  command.ts   UninstallString 안전 파서 (순수 함수, SAFETY §6)
  uninstall.ts UninstallService: plan → (확인 토큰) → start → 종료 대기 → 종료 코드 해석 → 목록 새로 읽기·남은 폴더 후보
src/main/ipc/programSchemas.ts  프로그램 IPC 입력 스키마 (electron 무관, strict)
```

- 제거 프로그램은 `ProcessPort`(`spawn`, `shell:false`, `stdio:ignore`)로 실행하고 종료를 기다린다. 종료 코드 0 은 완료, 3010/1641 은 완료+재부팅 필요, 1602/1223 은 사용자 취소, 그 밖은 실패. 종료 코드가 0 이어도 목록에 아직 남아 있으면 그렇게 알린다(스스로 다시 실행하는 제거 프로그램).
- 일반 실행이 권한 오류로 시작하지 못하면 `ElevationPort` 로 같은 명령을 UAC 재실행한다(명령 변경 없음).
- 가짜 드라이브(`DISKLENS_FAKE_DRIVE`) 모드에서는 실제 레지스트리 대신 `<가짜 루트>\fake-registry.json` 을 읽고(`FileRegistryReader`) 상승 포트는 없다. E2E·단위 테스트는 `tests/fixtures/mockUninstaller.ts` 의 모의 제거 프로그램(node.exe + 스크립트)만 실행한다.
- 제거 프로그램은 삭제 API 를 호출하지 않는다 (`deletionIsolation.test.ts` 와 `uninstallService.test.ts` 의 정적 검사).

### 7.2 관리자 헬퍼 (8단계 구현)

```
src/main/helper/
  adminRules.ts   헬퍼가 지울 수 있는 항목의 하드코딩 허용 목록 (win-system-temp, win-minidump, win-cbs-logs, win-update-download)
  job.ts          job 스키마(strict) + HMAC 서명 + verifyJob (구조 → 토큰 해시 → 서명 → 시간 → 허용 목록)
  jobFiles.ts     elevated/ 폴더의 파일 이름(job.json, result.json, cancel.json), 결과 스키마, 임시파일+rename 쓰기
  runHelper.ts    헬퍼 본체 (Electron 무관, 테스트에서 샌드박스로 실행). job 검증 → 자체 규칙 구성 → 자체 보호 검사로 정리
  env.ts          상승 프로세스의 환경변수 검증 (SystemRoot 가 <드라이브>:\Windows 일 때만, 나머지 경로는 직접 생성)
  elevation.ts    UAC 상승 포트 (PowerShell Start-Process -Verb RunAs, 고정 스크립트, 값은 환경변수로 전달)
  adminClient.ts  main 쪽: job 작성 → UAC 실행 → 결과 파일 검증. CleanupService 가 쓰는 AdminCleanupPort 구현
  helperMain.ts   `--cleanup-helper` 진입점 (창 없음, 일이 끝나면 app.exit(종료 코드))
```

- **실행**: 같은 실행 파일을 `--cleanup-helper --job <userData>/elevated/job.json --token <64자 hex>` 인자로 UAC 상승 실행한다. 인자로 받는 것은 job 위치와 토큰뿐이고 **경로 삭제 요청은 받을 수 없다**.
- **job 파일**: `{ schemaVersion, jobId, itemIds[], mode, acknowledgeCaution, createdAt, expiresAt, tokenHash, mac }` 만 담는다. 알 수 없는 필드(`paths`, `path`, `targets` 등)가 있으면 파일 전체를 거부한다. `tokenHash = sha256(token)`, `mac = HMAC-SHA256(token, 정식 문자열)`. 유효 시간은 2분. 이름은 `job.json` 이고 폴더 이름이 `elevated` 가 아니면 읽지 않는다. 링크(심볼릭/정션)로 바뀐 파일, 8KB 초과 파일도 거부한다.
- **거부 사유 코드**: `unreadable` `too-large` `not-regular-file` `malformed` `extra-fields` `bad-token` `bad-signature` `expired` `not-yet-valid` `item-not-allowed` `duplicate-items` `caution-not-acknowledged` (+ `bad-location`). 거부되면 아무것도 지우지 않고 종료 코드 2, `result.json` 에 `ok:false` 와 사유를 남긴다.
- **신뢰 모델(정직하게)**: job 은 사용자 쓰기 가능 폴더에 있고 서명 키(token)는 실행 인자로 전달되므로, 서명은 변조·재사용을 걸러내는 장치일 뿐 "같은 사용자 권한의 악성 프로그램"까지 막는 장치는 아니다. 실제 한계선은 ① UAC 동의 창, ② 헬퍼의 하드코딩 허용 목록이다: 서명이 맞아도 허용 목록 밖의 항목 ID 는 거부하고, 허용 항목도 `DeleteGuard`(보호 경로)와 대상 재확인을 헬퍼가 다시 한다. 최악의 경우에도 지울 수 있는 곳은 허용 항목 4곳의 규칙 범위(오래된 임시·로그·덤프·업데이트 캐시)뿐이다.
- **환경변수**: 헬퍼는 실행한 쪽의 환경변수를 믿지 않는다. `SystemRoot` 가 정확히 `<드라이브>:\Windows` 일 때만 받아들이고 나머지 경로는 드라이브 문자로 직접 만든다. 영구 삭제 허용 여부는 job 이 아니라 `<userData>/settings.json` 에서 헬퍼가 직접 읽는다 (없거나 깨졌으면 꺼짐). 사용자 규칙 파일(`user-rules.json`)과 번들 규칙 JSON 은 읽지 않는다.
- **앱 쪽 흐름**: `CleanupService` 는 관리자 항목을 UAC 한 번으로 묶어 `AdminCleanupPort.run` 에 맡긴다. 거부(`declined`)는 항목별 `admin-declined`, 실행 실패·결과 없음·jobId 불일치·헬퍼의 거부는 `other` 로 건너뛰며 앱은 정상 동작한다. 결과 파일도 zod 로 검사하고, 요청하지 않은 항목 ID 는 무시한다. 허용 목록 밖의 관리자 항목이 섞이면 그 묶음 전체를 헬퍼로 보내지 않는다.
- **취소**: 앱이 `cancel.json`({ jobId })을 쓰면 헬퍼가 25개 파일마다 확인해 멈춘다. 다른 jobId 의 오래된 취소 파일은 무시한다.
- **파일을 지우지 않는다**: `elevated/` 의 파일은 항상 임시 파일을 거쳐 rename 으로 덮어쓴다. 이전 실행의 `result.json` 은 jobId 불일치로 무시된다. 로그는 일반 정리와 같은 `logs/cleanup-*.log` 에 헬퍼가 직접 남긴다 (작업 ID `<jobId>-helper*`).
- **지원하지 않는 것**: `win-old`(Windows.old, 디스크 정리 호출)는 전용 동작이라 여전히 지원하지 않는다 (`admin-declined`).
- **가짜 드라이브(개발/E2E)**: 앱은 UAC 포트를 연결하지 않아 관리자 항목은 `admin-declined` 로 건너뛴다. 헬퍼 프로세스 자체는 `DISKLENS_FAKE_DRIVE` 로 샌드박스에서 직접 실행해 E2E 한다 (`tests/e2e/helper.spec.ts`).
- 상승 실행 방식의 한계: 일반 사용자가 관리자 계정 자격 증명으로 UAC 를 통과하면 상승 프로세스의 프로필이 달라질 수 있다. 헬퍼의 허용 항목은 `%WINDIR%` 아래만 쓰므로 영향이 없고, `userData` 는 job 위치에서 얻는다.
- 패키징(11단계)에서 `requestedExecutionLevel` 은 `asInvoker` 를 유지한다.

## 8. 규칙 매칭 설계

- 로딩 시: 규칙 DB(내장 + 사용자) 읽기 → zod 검증 → 안전 검증(`validate.ts`: 보호 경로 침범/허용 열거 범위 위반 규칙 거부) → 환경변수 확장 → 정규화 → **경로 트라이(trie) 또는 정렬 배열**로 인덱싱.
- 매칭 입력: 노드의 전체 경로. 출력: 가장 구체적인 규칙 1개(+상위 규칙 목록).
- 패턴 종류: `exact`(정확 경로), `prefix`(하위 전체), `glob`(예: `**/node_modules`, `**/Cache`), `name`(폴더/파일 이름만).
- glob/name 규칙은 스캔 시점이 아니라 **조회 시점(`scan:getChildren`, `rules:describe`)에 노드 경로로 매칭**한다 (스캔 성능 보호). 단 §5.3의 접기 예외를 위해 규칙이 지칭하는 폴더 이름 패턴(`node_modules`, `Library` 등)은 worker가 알고 있어야 한다.
- 설치 프로그램 연결: `programs` 서비스가 `InstallLocation`을 읽어 (1) 스캔 시 접지 않을 경로 힌트(`keepPaths`)로 쓰고, (2) 현재 스캔 결과에서 같은 경로의 노드를 찾아 `InstalledProgram.scanNode`와 (레지스트리에 용량이 없을 때) 폴더 용량을 채운다. 반대 방향(스캔 탭 상세의 "프로그램 탭에서 보기")은 renderer 가 목록의 `installLocation`과 노드 경로를 비교해 가장 깊은 설치 폴더를 고른다.
- 레지스트리 읽기(`programs/registry.ts`)는 네이티브 모듈 없이 고정된 PowerShell 스크립트(`Get-ChildItem`/`Get-ItemProperty`만 사용)로 한다. 쓰기/삭제 함수는 만들지 않으며, 테스트가 스크립트에 쓰기 동작이 없음을 검사한다.

## 9. 상태 관리 (renderer)

- Zustand 스토어: `scanStore`(진행/요약/선택 노드), `rulesCache`(노드 ID → 매칭 결과 캐시), `programsStore`, `cleanupStore`, `settingsStore`.
- 트리는 **지연 로딩**: 노드를 펼칠 때 `scan:getChildren` 호출. 한 화면에 수천 행이 필요하면 가상 스크롤.
- IPC 응답은 렌더 전용 뷰 모델(`NodeView`)로 받는다. 큰 객체를 통째로 상태에 올리지 않는다.

## 10. 저장 위치 (사용자 데이터 폴더, `app.getPath('userData')`)

```
settings.json
scan-cache/
logs/
user-rules.json        (사용자 추가 규칙, P1)
cleanup-history.json
```

- 앱 제거 시 사용자 데이터 삭제 여부는 NSIS 설치 프로그램이 묻는다.

## 11. 오류 처리·로깅

- main 전역 `uncaughtException`/`unhandledRejection` 핸들러: 로그 기록 + 사용자에게 오류 알림 후 안전 종료(진행 중 정리 작업이 있으면 중단 상태 기록).
- renderer 오류 경계(Error Boundary) + "오류 보고서 폴더 열기".
- 모든 서비스는 에러를 구조화된 코드로 반환 (예: `SAFETY_DENIED`).

## 12. 빌드·배포

- `electron-builder.yml`(11단계 구현): appId `com.disklens.app`, productName `DiskLens`, 아이콘 `build/icon.ico`(`scripts/make-icon.mjs` 가 그린다), `nsis`(oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, 시작 메뉴·바탕화면 바로가기), `portable`, `requestedExecutionLevel: asInvoker`.
- 규칙 DB(`resources/cleanup-rules.json`)는 `extraResources`로 `<설치 폴더>\resources\cleanup-rules.json` 에 두고 main 이 `process.resourcesPath` 에서 읽기 전용으로 읽는다. 앱 코드는 asar 안(스캔 worker 포함 — asar 안에서도 동작 확인).
- 코드 서명 없음. 산출물: `release/DiskLens-Setup-x.y.z.exe`, `release/DiskLens-Portable-x.y.z.exe` (`release/`는 git 제외).
- `npm run dist` = `electron-vite build` + `scripts/dist.mjs`. 백신이 `node_modules\electron\dist\electron.exe` 를 막는 PC 에서는 `.electron-dist2`(또는 `DISKLENS_ELECTRON_DIST`)에 풀어 둔 Electron 배포판을 electron-builder 의 `electronDist` 로 넘긴다.
- 사용자 데이터 폴더는 `%APPDATA%\disklens` (패키징된 앱의 app name 이 `disklens`). 제거 프로그램(NSIS, `build/installer.nsh`)은 이 폴더를 지울지 묻는다(기본 "아니요", 조용한 제거·업데이트에서는 항상 보존).
- 패키징된 앱(`app.isPackaged`)은 `DISKLENS_FAKE_DRIVE`/`DISKLENS_USER_DATA`/`DISKLENS_SCAN_ROOT` 를 무시한다. 설치본 점검(`tests/e2e/packaged.spec.ts`)은 `--user-data-dir` 로 임시 사용자 데이터를 쓰고, 실제 레지스트리는 읽기만 하며, 삭제/정리/제거는 실행하지 않는다.
- 관리자 헬퍼는 같은 `DiskLens.exe` 를 `--cleanup-helper` 로 UAC 상승 실행한다 (포터블은 임시 폴더에 풀린 exe 를 쓴다).

## 13. 확장 지점 (이번 범위 밖, 구조만 고려)

- 다른 드라이브 스캔: `root`를 인자로 받으므로 구조상 가능. UI만 C: 고정.
- 스캔 엔진 교체: `ScanEngine` 인터페이스(`start`, `cancel`, `onProgress`)를 두고 Node 구현체/ WizTree CSV 가져오기 구현체/ 네이티브 구현체를 바꿔 끼울 수 있게 한다.
- AI 설명: 이번 버전에서는 만들지 않는다. `RuleSource` 인터페이스로 규칙 공급을 추상화해 두면 이후 추가 가능.
