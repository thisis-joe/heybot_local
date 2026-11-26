# 검증 결과와 재현 방법

[빠른 시작](../README.md) · [운영 가이드](operations.md)

## 검증

`npm test`는 격리 HTTP·Git 서버와 모델 응답으로 양쪽 포지의 CLI 흐름을 검증합니다. 실제 연동 결과는 아래 표에 함께 기록합니다.

| 항목 | 검증 범위 |
| --- | --- |
| 설치 패키지 | `npm pack`으로 만든 tarball을 깨끗한 npm 디렉터리에 설치. v0.3.0에서 macOS(Node 26.0.0)와 Linux ARM64(Node 22.13.0) 각각 전체 테스트 138개와 설치된 CLI 테스트 27개 통과 |
| 폴링과 복구 | 두 댓글 표면, 페이지네이션과 429 후 재개, 응답 유실 후 마커 대조, SQLite 이력, 전용 게시자와 관찰자 |
| 모델 | 공식 Codex CLI 0.169.0과 ChatGPT 로그인으로 한국어 질문 생성과 근거 채점 확인. Claude API 구조화 출력 및 Ollama 출제·채점은 격리 응답으로 검증. 실행 중인 Ollama와 테스트용 Claude API 키가 없어 두 모델의 실제 호출은 미검증 |
| GitHub | 사용자 승인 테스트 저장소에서 설치 패키지로 검증. PR #1의 실제 머지, 요약 1개와 인라인 질문 2개, 같은 계정의 복수 답변과 근거 채점, 문항별 인라인 해설. PR #2에서 `requireAnswers`의 pending→success와 닫힌 PR의 도움말 확인. [머지 PR](https://github.com/thisis-joe/heybot_local/pull/1) · [채점](https://github.com/thisis-joe/heybot_local/pull/1#issuecomment-7186399720) · [스레드 해설](https://github.com/thisis-joe/heybot_local/pull/1#discussion_r4705494257) · [답변 상태 PR](https://github.com/thisis-joe/heybot_local/pull/2) |
| GitLab | 격리된 MR·디스커션·커밋 상태와 알림 테스트. 공개 GitLab 프로젝트에서 목록 및 Push 이벤트 응답 확인. 사용자 인증이 필요한 실제 GitLab MR 게시·상태는 미검증 |
| 협업 알림 | 두 포지에서 변경 요청·댓글·질문·Push·새 브랜치와 네 웹훅 전송 형식을 격리 검증했습니다. 실제 GitHub 저장소의 재열기·닫기·댓글·브랜치 생성·Push 5건도 로컬 수신기에서 확인했습니다. 재조회 시 추가 전송은 0건이었습니다. [테스트 댓글](https://github.com/thisis-joe/heybot_local/pull/2#issuecomment-7186672328) · [테스트 브랜치](https://github.com/thisis-joe/heybot_local/tree/verify/heybot-local-notifications) |
| 알림 제어 | GitHub·GitLab 격리 CLI에서 이벤트 선택, 재활성화와 중복 방지, 댓글 미리보기의 대기열 제거, 질문 게시와 댓글 명령을 확인했습니다. |

실연동은 공개 `heybot_local` 저장소의 테스트 브랜치와 합성 코드에 한정했습니다. `doctor`에서도 이 저장소에 대한 실제 인증, 읽기, 권한 메타데이터와 Codex 로그인 조회를 확인했습니다.

### 운영체제·사내 포지 검증 (2026-11-26)

| 대상 | 확인 결과 |
| --- | --- |
| Linux ARM64 (Debian 12) | Node 22.13.0, npm 10.9.2, Git 2.39.5. 공백·한글이 있는 소스와 설치 경로에서 `npm ci`, v0.3.0 전체 테스트 138개, `npm pack`, 임시 설치 경로의 CLI 테스트 27개를 통과했습니다. Git에서 받은 공백·한글 파일명이 모델 입력에 포함되는 것도 확인했습니다. |
| Linux 감시 종료 | 포그라운드 감시가 첫 조회를 저장하면 두 번째 감시가 SQLite 잠금으로 거부됩니다. `SIGINT`와 `SIGTERM`에서 종료 코드 0, `status`의 `watching: false`, 이후 `watch --once` 재실행을 확인했습니다. |
| Windows | 네이티브 실행이 남아 있습니다. 아래 절차에서 Git for Windows, npm `.cmd` 실행, 공백·한글 경로, 설치된 CLI 통합 테스트와 콘솔 `Ctrl+C` 종료를 확인할 수 있습니다. [Node 자식 프로세스](https://nodejs.org/download/release/v22.13.0/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows) · [Node 신호 처리](https://nodejs.org/download/release/v22.13.0/docs/api/process.html#signal-events) |
| GitHub Enterprise·비공개 GitLab | 루프백 fixture에서 GHES `/api/v3`, GitLab `/gitlab/api/v4`와 중첩 프로젝트의 인코딩, 토큰과 계정 확인, 잘못된 토큰과 게시 계정 거부, 인증된 Git fetch(HTTP 객체 서빙)를 확인했습니다. GHE.com은 API 호스트에서 웹·Git 호스트를 계산하는 테스트를 통과했습니다. 승인된 실제 사내 포지에서 연결·읽기·게시 권한 확인이 남아 있습니다. [GitLab 경로 인코딩](https://docs.gitlab.com/api/rest/#namespaced-paths) |
| 사내 CA | 합성 CA를 사용하는 로컬 HTTPS GHES fixture에서 CA 설정 전 REST 실패와 설정 후 REST·Git fetch 성공을 확인했습니다. 실제 사내 CA 및 Git for Windows에서의 TLS 연동 확인이 남아 있습니다. |

#### Linux 재현

Node.js와 Git, OpenSSL이 있는 Linux에서 저장소 루트를 공백·한글이 포함된 경로에 두고 실행합니다. 위 검증에는 `node:22.13.0-bookworm`을 사용했습니다. `HEYBOT_TEST_TLS=1`은 루프백 HTTPS 테스트를 켭니다.

```sh
npm ci
HEYBOT_TEST_TLS=1 npm test
npm pack
scratch="$(mktemp -d)"
prefix="$scratch/HeyBot 검증"
npm install -g --prefix "$prefix" ./heybot_local-0.3.0.tgz
"$prefix/bin/heybot_local" --help
HEYBOT_TEST_TLS=1 HEYBOT_PACKED_BIN="$prefix/bin/heybot_local" node --test test/local-flow.test.mjs
rm -rf -- "$scratch"
```

#### Windows 재현

Node.js와 Git for Windows가 있는 PowerShell에서 저장소 루트를 공백·한글이 포함된 경로에 두고 실행합니다.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd pack
$prefix = Join-Path ([IO.Path]::GetTempPath()) ("HeyBot 검증 " + [guid]::NewGuid())
npm.cmd install -g --prefix $prefix .\heybot_local-0.3.0.tgz
$bin = Join-Path $prefix 'heybot_local.cmd'
& $bin --help
$env:HEYBOT_PACKED_CLI = Join-Path $prefix 'node_modules\heybot_local\dist\cli.js'
node --test .\test\local-flow.test.mjs
Remove-Item Env:HEYBOT_PACKED_CLI
```

Windows 콘솔 종료를 확인하려면 별도 PowerShell 창에서 다음 로컬 응답기를 실행합니다.

```powershell
@'
require('node:http').createServer((req, res) => {
  const value = req.url === '/user' ? { login: 'fixture' } : req.url.includes('?') ? [] : { id: 1 };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}).listen(19735, '127.0.0.1');
'@ | node -
```

설치한 창에서 관찰 모드로 감시를 시작합니다.

```powershell
$env:HEYBOT_HOME = Join-Path $prefix 'watch-profile'
$env:HEYBOT_TEST_TOKEN = 'fixture'
Write-Output $env:HEYBOT_HOME
Write-Output $bin
& $bin connect github fixture/repo --publisher fixture --observe --token-env HEYBOT_TEST_TOKEN --instance http://127.0.0.1:19735
& $bin watch --interval 3600
```

다른 PowerShell 창에서 출력된 `HEYBOT_HOME`을 설정하고 같은 `heybot_local.cmd`의 `status`에서 `watching: true`와 조회 커서 1개를 확인합니다. 감시 창에서 `Ctrl+C`를 누른 뒤 그 창에서 아래 명령을 실행합니다. `watching: false`와 `watch --once` 성공을 확인합니다. 검증을 마치면 로컬 응답기도 `Ctrl+C`로 종료하고 임시 설치 경로를 삭제합니다.

```powershell
& $bin status
& $bin watch --once
$LASTEXITCODE
```

## 범용 배포에서 확인할 항목

| 항목 | 현재 지원 범위와 남은 확인 |
| --- | --- |
| 운영체제와 포지 | Windows 네이티브 설치·종료와 GitHub Enterprise·비공개 GitLab·사내 CA 실연동이 남아 있습니다. 사내 포지 읽기는 승인된 저장소에서 `connect … --observe`와 `watch --once`로 확인할 수 있습니다. |
| 최초 설정 | `doctor`로 토큰·저장소 읽기와 권한 메타데이터, 모델·웹훅 설정을 점검할 수 있습니다. 댓글·커밋 상태 쓰기와 웹훅 수신은 실제 작업에서 확인합니다. |
| 모델 인증 | Codex ChatGPT 로그인, Claude API 키, 로컬 Ollama를 설정할 수 있습니다. Claude 구독과 Ollama·Claude 유료 API의 실제 실행 범위는 검증 표를 참고합니다. |
| 알림 관리 | 저장소마다 알림 대상 한 곳, 이벤트 종류와 댓글 미리보기 표시 여부를 설정할 수 있습니다. 실제 협업 채널에서 설정 전환과 수신을 확인할 항목이 남아 있습니다. |
| 계속 실행과 인계 | 지정 PC가 꺼져 있는 동안엔 게시가 멈추고 재시작 시 커서에서 복구합니다. 다른 PC에 맡길 때는 프로필과 게시 계정 이관이 필요합니다. |
