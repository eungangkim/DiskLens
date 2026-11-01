# DATA_SPEC — 데이터 명세

모든 타입은 `src/shared/types.ts`에 TypeScript 인터페이스와 zod 스키마로 함께 정의한다. 이 문서는 그 기준이다.

## 1. 규칙 DB (cleanup-rules.json)

### 1.1 파일 구조

```jsonc
{
  "schemaVersion": 1,
  "rulesVersion": "2026.11.01",
  "description": "DiskLens 내장 규칙",
  "pathRules": [/* PathRule[] */],
  "programRules": [/* ProgramRule[] */]
}
```

### 1.2 PathRule (폴더/파일 규칙)

```ts
interface PathRule {
  id: string // 고유. 소문자-kebab. 예: "win-user-temp"
  name: string // 표시 이름(한국어). 예: "사용자 임시 폴더"
  match: {
    kind: 'exact' | 'prefix' | 'glob' | 'name'
    pattern: string // 환경변수 허용: %LOCALAPPDATA%, %USERPROFILE%, %APPDATA%, %PROGRAMDATA%, %WINDIR%, %SYSTEMDRIVE%, %PROGRAMFILES%, %PROGRAMFILES(X86)%
  }
  category:
    | 'temp'
    | 'cache'
    | 'log'
    | 'dump'
    | 'update'
    | 'dev-cache'
    | 'dev-build'
    | 'app-data'
    | 'system'
    | 'user-data'
    | 'program'
    | 'game'
    | 'vm'
    | 'other'
  safety: 'safe' | 'caution' | 'protected' // unknown은 "규칙 없음" 상태이므로 규칙에 쓰지 않는다
  description: string // 이게 뭔지 1~2문장
  impact: string // 지우면 생기는 영향 (safe라도 "다시 생성됨" 등 작성)
  cleanable: boolean // 정리(자동정리) 항목으로 노출할지
  cleanup?: {
    // cleanable=true일 때 필수
    mode: 'contents' | 'self' // contents: 폴더 내용물만 삭제(폴더 유지), self: 폴더 자체 삭제
    includeGlobs?: string[] // 대상을 더 좁힐 때 (예: ["thumbcache_*.db"])
    excludeGlobs?: string[] // 제외 (예: 사용 중인 파일 이름 패턴)
    minAgeDays?: number // N일 지난 파일만 (임시 폴더에 유용)
    requiresAdmin: boolean
    allowPermanent: boolean // 영구 삭제 허용 (category가 temp/cache일 때만 true 가능. SAFETY.md §4 기준)
    group: string // UI 정리 화면 그룹명. 예: "Windows", "브라우저", "개발 도구"
    defaultSelected: boolean // 정리 화면에서 기본 체크 (safe만 true 가능)
    needsProcessClosed?: string[] // 실행 중이면 건너뛰거나 안내할 프로세스 이름. 예: ["chrome.exe"]
    specialAction?: 'empty-recycle-bin' | 'run-disk-cleanup' // 일반 삭제가 아닌 전용 동작
  }
  tags?: string[] // 검색/필터용
  reference?: string // 근거 설명(문서 메모). 선택
}
```

#### 검증 규칙 (`rules/validate.ts`)

로딩 시 다음을 위반하는 규칙은 **로드 거부 + 경고 로그**(앱은 계속 동작):

1. `cleanable: true`인데 `safety`가 `protected` → 거부.
2. `cleanable: true`인데 `cleanup`이 없음 → 거부.
3. `cleanup.allowPermanent: true`인데 `category`가 `temp|cache`가 아님 → 거부. (log/dump는 휴지통 이동만 가능. SAFETY.md §4와 일치)
4. `cleanup.defaultSelected: true`인데 `safety !== 'safe'` → 거부.
5. `cleanable: true` 규칙의 대상 경로가 SAFETY.md §3 보호 경로 안에 있고, §5 정리 허용 예외 열거에 해당하지 않음 → 거부.
6. `cleanable: true` 규칙의 `match.pattern`이 드라이브 루트, `C:\Users`, 사용자 개인 폴더 루트 등 지나치게 넓음 → 거부. (`cleanable: false` 보호/표시 전용 규칙은 정보 제공용이므로 예외)
7. 같은 `id` 중복 → 뒤의 것 거부.
8. 사용자 규칙(`user-rules.json`)은 `safety: 'protected'`를 **낮출 수 없다** (같은 경로에 내장 규칙이 protected면 내장 우선).

#### 매칭 의미

- `exact`: 정규화한 전체 경로가 동일.
- `prefix`: 해당 경로 및 모든 하위. (경계 `\` 확인)
- `glob`: 경로 전체에 대한 glob (`**` 지원, 대소문자 무시). 예: `%USERPROFILE%\**\node_modules`
- `name`: 경로의 마지막 이름만 비교(예: `node_modules`). 위치 무관해서 오탐 위험이 있으므로 `safety`를 보수적으로.
- 우선순위: `exact` > 긴 `prefix`/`glob`(구체적) > `name`. 동률이면 보수적 안전도(`protected` > `unknown` > `caution` > `safe`, SAFETY.md §2와 동일).
- 구체성 점수: `exact` > `prefix`/`glob`(패턴에서 와일드카드를 뺀 글자 수가 긴 쪽) > `name`.
- **상속**: `prefix`/`glob`/`name` 규칙은 일치한 폴더의 하위 경로에도 적용된다(`exact`는 그 경로 자신만). 일치한 폴더 자신은 "규칙 루트"이고 하위는 규칙을 물려받은 것이다(필터 목록은 규칙 루트만 보여 준다).
- **내장 protected 우선**: 내장 규칙 중 가장 구체적인 것이 `protected`이면 사용자 규칙은 무시된다(안전도를 낮출 수 없음).
- **하드코딩 보호 구역**(SAFETY.md §3): 매칭된 규칙이 `protected`가 아니어도, 경로가 보호 구역 안이고 §5 정리 허용 예외가 아니면 🔴 protected(`ruleId: hardcoded-protected`)로 표시한다.
- 검증은 6(너무 넓음)을 5(보호 경로 침범)보다 먼저 확인한다(더 구체적인 사유를 보고하기 위함). 5의 판정은 패턴의 고정 부분과 와일드카드를 대표 문자로 바꾼 표본 경로로 하는 휴리스틱이다.
- `RuleMatch.canDelete`는 스캔 결과에서는 계속 `false`로 둔다. 정리 가능 여부의 기준은 정리 항목 목록(`cleanup:items`)이며, 스캔 상세의 "이 항목 정리하기" 버튼은 그 목록에 규칙 ID가 있을 때만 보인다. 실제 삭제 허용 판정은 항상 `DeleteGuard`가 실행 시점에 다시 한다.

#### 표시 전용 규칙 (`cleanable: false`)

- `safety`가 `caution`이어도 `cleanable: false`이면 앱에서 **삭제 버튼을 제공하지 않는다** (`RuleMatch.canDelete = false`). 설명과 안전도만 보여주는 용도다 (예: `node_modules`, Steam 게임 폴더, Docker 데이터).
- UI 상세 패널: `caution` + 표시 전용이면 "이 앱에서는 삭제를 지원하지 않습니다. 필요하면 탐색기에서 직접 확인하세요" 문구와 [탐색기에서 열기]만 제공한다.

#### 카테고리 사용 메모

- 실제로 정리하는 캐시(npm/pip/브라우저/셰이더 등)는 `category: "cache"`를 쓴다. 영구 삭제 허용 조건(`temp|cache|log|dump`)과 맞추기 위함이다.
- `dev-cache`, `dev-build`는 **표시 전용** 규칙(프로젝트 의존성 폴더 등)에 쓴다.

### 1.3 ProgramRule (설치 프로그램 규칙)

```ts
interface ProgramRule {
  id: string
  match: {
    nameContains?: string[] // 표시 이름에 포함(대소문자 무시). 배열의 모든 항목이 포함되어야 매칭(AND)
    nameRegex?: string // 표시 이름에 대한 정규식(대소문자 무시)
    publisherContains?: string[] // 게시자에 포함. 하나라도 포함되면 매칭(OR)
    // 여러 조건을 함께 쓰면 모두 만족해야 매칭(AND). 여러 규칙이 매칭되면 보수적 안전도 우선
  }
  name: string // 설명용 이름
  category:
    | 'driver'
    | 'runtime'
    | 'redistributable'
    | 'security'
    | 'system'
    | 'dev-tool'
    | 'game-launcher'
    | 'app'
    | 'other'
  safety: 'safe' | 'caution' | 'protected'
  description: string
  impact: string
}
```

- 로드 시 검증: 조건이 하나도 없는 규칙(모든 프로그램에 걸림)과 잘못된 `nameRegex`는 `invalid-pattern`으로 거부하고, 중복 id 는 먼저 나온 것만 유지한다. 규칙 하나가 거부돼도 나머지는 동작한다.
- 프로그램 규칙이 없는 프로그램은 `unknown`이되, **제거는 허용**한다 (일반 앱은 사용자의 선택). `SystemComponent=1`이면 `caution`으로 취급.
- `protected`는 제거 버튼 비활성.

## 2. 사용자 규칙 (user-rules.json, P1)

- 형식은 내장 규칙과 동일. `source: 'user'`로 표시되어 UI에 "사용자 규칙" 배지.
- 내장 규칙과 같은 `id`는 무시. 검증 규칙(§1.2) 동일 적용.
- 사용자 규칙은 `requiresAdmin: true`나 `specialAction`을 가진 정리 항목을 만들 수 없다(ARCHITECTURE.md §7). 위치: 앱 사용자 데이터 폴더의 `user-rules.json`(없으면 건너뜀).

## 3. 런타임 타입

### 3.1 스캔

```ts
type NodeId = string // 스캔 세션 내 고유(숫자 문자열 또는 해시)

interface ScanOptions {
  excludePaths: string[]
  allocatedSize: boolean // 디스크 점유 크기 기준
  clusterSize?: number // 기본 4096
  topFilesK: number // 기본 500
  collapseThresholdBytes: number // 기본 1MB. 이 크기 미만 폴더는 "기타 N개"로 접는다 (부모 비율 기준은 쓰지 않음)
  keepPaths: string[] // 접지 않을 규칙 경로(전체 경로). 그 상위 폴더도 함께 유지
  keepNames: string[] // 접지 않을 폴더 이름 (예: node_modules, Library)
  concurrency: number // 동시 처리 폴더 수. 기본 16
  skippedSampleMax: number // 건너뜀 목록 샘플 최대 개수. 기본 1000
}

interface ScanProgress {
  scanId: string
  filesScanned: number
  dirsScanned: number
  bytesScanned: number
  skippedCount: number
  currentPath: string
  elapsedMs: number
}

interface ScanSummary {
  scanId: string
  root: string
  startedAt: string // ISO
  finishedAt: string
  totalBytes: number
  totalFiles: number
  totalDirs: number
  skippedCount: number
  cancelled: boolean
  allocatedSize: boolean
  rootNodeId: NodeId
  driveInfo?: { totalBytes: number; freeBytes: number }
}
```

### 3.2 노드 (main 내부 저장 형태)

```ts
interface FolderNode {
  id: NodeId
  parentId: NodeId | null
  name: string
  path: string // 필요 시 parent 체인으로 복원 가능. 메모리 절약 위해 저장 방식은 구현 재량
  size: number // 하위 전체 합
  ownFilesSize: number // 이 폴더 직계 파일 합
  ownFileCount: number
  fileCount: number // 하위 전체 파일 수
  dirCount: number
  childIds: NodeId[] // 접힌(collapsed) 폴더는 포함되지 않음
  collapsed?: { count: number; size: number } // "기타 N개 폴더" 합계
  isLink?: boolean
  cloudOnly?: boolean
  skippedChildren?: number
  truncated?: boolean // 접근 불가 등으로 불완전
}

interface TopFileEntry {
  path: string
  size: number
  modifiedAt: string
  ext: string
}
```

### 3.3 UI 전달용 뷰 모델

```ts
interface NodeView {
  id: NodeId
  kind: 'folder' | 'file' | 'collapsed'
  name: string
  path: string
  size: number
  percentOfParent: number
  percentOfTotal: number
  fileCount?: number
  hasChildren: boolean
  isLink?: boolean
  cloudOnly?: boolean
  match?: RuleMatch // 규칙 매칭 결과(없으면 unknown)
  programHint?: { programId: string; programName: string; publisher?: string }
}

interface RuleMatch {
  ruleId: string | null // null이면 규칙 없음
  source?: 'builtin' | 'user'
  name?: string
  safety: 'safe' | 'caution' | 'protected' | 'unknown'
  category?: string
  description?: string
  impact?: string
  cleanable: boolean
  canDelete: boolean // safety.ts 판정 결과(UI 버튼 활성 여부의 근거)
}

interface TypeSummary {
  type:
    | 'video'
    | 'image'
    | 'audio'
    | 'archive'
    | 'executable'
    | 'document'
    | 'code'
    | 'disk-image'
    | 'other'
  bytes: number
  fileCount: number
}

interface SkippedItem {
  path: string
  reason: 'permission-denied' | 'busy' | 'not-found' | 'other'
}
```

### 3.4 설치 프로그램

```ts
/**
 * UI 로 전달되는 형태. `UninstallString`/`QuietUninstallString`은 main 안의 내부 레코드(`ProgramRecord`)에만 두고
 * UI 로 보내지 않는다 (9단계에서 main 이 programId 로 다시 찾아 실행한다).
 */
interface InstalledProgram {
  id: string // 레지스트리 키 이름 + hive 해시
  name: string // DisplayName
  publisher?: string
  version?: string
  installDate?: string // YYYY-MM-DD (레지스트리 값 파싱 실패 시 undefined)
  installLocation?: string
  estimatedSizeBytes?: number // EstimatedSize(KB) * 1024 또는 폴더 스캔 결과
  sizeSource: 'registry' | 'scan' | 'unknown'
  isSystemComponent: boolean // SystemComponent=1 또는 ParentKeyName 존재 등
  scope: 'machine' | 'machine-x86' | 'user'
  match?: RuleMatch // ProgramRule 결과 (ruleId는 programRule id)
  canUninstall: boolean // 안전한 제거 명령이 있고 protected 가 아니면 true (9단계)
  uninstallBlock?: 'protected' | 'no-command' | 'unsupported-command' // canUninstall=false 일 때 이유
  scanNode?: { scanId: string; nodeId: string } // 설치 폴더가 현재 스캔 결과에 있으면 그 노드
}

interface UninstallPlan {
  programId: string
  name: string
  publisher?: string
  version?: string
  sizeBytes?: number
  safety: 'safe' | 'caution' | 'unknown'
  warnings: string[]
  needsCautionAck: boolean // caution 또는 규칙 없는 시스템 구성요소
  installerKind: 'msi' | 'exe'
  installerName: string // 실행할 제거 프로그램 이름 (예: unins000.exe)
  confirmationId: string // 일회용, 5분
  expiresAt: number
}

interface UninstallResult {
  programId: string
  name: string
  startedAt: number
  finishedAt: number
  status: 'finished' | 'failed' | 'cancelled' | 'declined'
  exitCode?: number
  rebootRequired: boolean
  stillListed: boolean | null // 제거 후 목록을 다시 읽었을 때 항목이 남아 있는지 (null = 확인 실패)
  message: string
  leftover?: { path: string; scanNode?: { scanId: string; nodeId: string } } // 보여주기만 한다
}
```

#### 설치 프로그램 해석 규칙 (`programs/parse.ts`)

- 읽는 위치 3곳(읽기 전용): `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`.
- `DisplayName`이 없거나 문자열이 아닌 항목은 목록에 올리지 않는다 (Windows 설정에도 안 나온다).
- `isSystemComponent`: `SystemComponent=1`, `ParentKeyName` 존재, `ReleaseType`이 Update/Hotfix/Security Update/Service Pack, 또는 `(KB1234567)` 업데이트 이름.
- `InstallDate`는 실제 존재하는 `YYYYMMDD`/`YYYY-MM-DD`만 인정(아니면 없음). `EstimatedSize`는 KB → 바이트, 0·음수·비정상 값은 없음. `InstallLocation`은 따옴표/끝 구분자를 정리하고 드라이브 절대경로만 인정(드라이브 루트·상대경로·UNC 제외).
- 중복 제거: 이름·게시자·버전이 같으면 같은 프로그램으로 보고 machine > machine-x86 > user 순으로 하나만 남기며 빈 값은 채운다. 하나라도 일반 프로그램이면 일반 프로그램으로 본다.
- 용량: 레지스트리 `EstimatedSize`가 있으면 `sizeSource: registry`, 없고 설치 폴더가 스캔 결과에 있으면 `scan`(설치 폴더 전체 용량이라 여러 프로그램이 같은 폴더를 쓰면 실제보다 크게 보일 수 있음), 둘 다 없으면 `unknown`.
- Microsoft Store(UWP) 앱은 Uninstall 레지스트리에 없으므로 이 목록에 포함되지 않는다.

### 3.5 정리

```ts
interface CleanupItem {
  // UI 정리 화면의 한 줄
  itemId: string // ruleId와 동일
  name: string
  group: string
  description: string
  impact: string
  safety: 'safe' | 'caution'
  estimatedBytes: number | null // 분석 전에는 null
  fileCount: number | null
  requiresAdmin: boolean
  allowPermanent: boolean
  defaultSelected: boolean
  needsProcessClosed?: string[]
  specialAction?: 'empty-recycle-bin' | 'run-disk-cleanup'
}

interface CleanupPlan {
  planId: string
  mode: 'trash' | 'permanent'
  items: Array<{
    itemId: string
    fileCount: number
    bytes: number
    sample: string[] // 대표 경로 3개
    warnings: string[] // caution 문구, 프로세스 실행 중 경고 등
  }>
  totalFiles: number
  totalBytes: number
  requiresAdmin: boolean
  needsCautionAck: boolean
  confirmationId: string // 일회용 토큰
  expiresAt: string // ISO
}

interface CleanupProgress {
  jobId: string
  itemId: string
  processedFiles: number
  freedBytes: number
  currentPath?: string
}

interface CleanupResult {
  jobId: string
  startedAt: string
  finishedAt: string
  mode: 'trash' | 'permanent'
  freedBytes: number
  deletedFiles: number
  skippedFiles: number
  cancelled: boolean
  error?: string // 로그를 쓸 수 없어 중단하는 등 작업 전체에 영향을 준 오류
  perItem: Array<{
    itemId: string
    freedBytes: number
    deletedFiles: number
    skipped: Array<{
      reason:
        'in-use' | 'permission-denied' | 'safety-denied' | 'not-found' | 'admin-declined' | 'link' | 'other'
      count: number
    }>
  }>
}

interface CleanupRecord {
  // 정리 기록 목록용
  jobId: string
  at: string
  mode: 'trash' | 'permanent'
  freedBytes: number
  itemIds: string[]
  // 10단계에서 추가 (이전 기록에는 없다): 기록 화면의 상세용
  deletedFiles?: number
  skippedFiles?: number
  cancelled?: boolean
  perItem?: CleanupItemResult[] // 항목별 확보 용량·삭제 파일 수·건너뜀 사유
}
```

### 3.6 설정

```ts
interface Settings {
  scanRoot: string | null // null = 기본 "C:\\". 폴더 선택 대화상자(main)로만 정하고, 저장 전 main 이 드라이브 절대경로·존재 여부를 다시 검증 (10단계)
  excludePaths: string[] // 드라이브 절대경로만, 최대 50개. 스캔에만 영향(삭제 안전 검사와 무관)
  sizeUnit: 'GB' | 'GiB' // 기본 'GiB'
  allowPermanentDelete: boolean // 기본 false (temp/cache 규칙에만 적용)
  theme: 'system' | 'light' | 'dark'
  // 10단계에서 만들지 않은 항목: allocatedSize(스캔은 항상 디스크 점유 기준), userRulesPath(고정: <userData>\user-rules.json), lastScanCacheId
}
// settings.json 은 schemaVersion 2 (1 은 allowPermanentDelete 만 있던 형식 — 읽을 때 이어받는다). 항목이 깨져 있으면 그 항목만 기본값.
```

## 4. 파일 저장 형식

- `settings.json`: `Settings` + `schemaVersion`.
- `scan-cache/<id>.json`: `{ schemaVersion, summary: ScanSummary, nodes: FolderNode[], topFiles: TopFileEntry[], typeSummary: TypeSummary[], skippedSample: SkippedItem[] }`. 용량이 크면 gzip 허용(`.json.gz`).
- `cleanup-history.json`: `CleanupRecord[]` (최근 500개).
- `logs/cleanup-YYYY-MM-DD.log`: 줄 단위 JSON(JSONL):
  `{"t":"2026-11-01T14:03:00+09:00","op":"delete","path":"...","mode":"trash","result":"ok","bytes":1234,"ruleId":"win-user-temp"}`
- 모든 저장 파일에 `schemaVersion`을 두고, 버전이 맞지 않으면 마이그레이션 함수 또는 안전한 초기화.

## 5. 규칙 작성 가이드 (규칙 추가 시)

1. **구체적으로 쓴다.** `**/Cache` 같은 넓은 glob보다 `%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache` 처럼 정확히.
2. 캐시는 **내용물만(`mode: contents`)** 지우고 폴더는 남긴다.
3. 로그인/설정/쿠키가 섞인 폴더는 `cleanable: false` + `caution`/`protected`로, 정리용 하위 폴더만 별도 규칙으로 분리.
4. `safe`는 "지워도 문제가 없고 자동 재생성되는 것"에만 쓴다. 조금이라도 불확실하면 `caution`.
5. `description`은 "이게 뭔지", `impact`는 "지우면 어떻게 되는지"를 일반인이 이해할 말로.
6. 각 규칙에 `reference`로 근거(예: 공식 문서 요지)를 남긴다.
7. 용량이 크지만 정리 불가능한 것(예: `hiberfil.sys`, `pagefile.sys`)은 `protected` + 설명에 **줄이는 방법(윈도우 설정)** 을 안내.
8. 새 규칙 추가 후 `npm test`의 규칙 검증 테스트(§1.2)를 통과해야 한다.
