# heybot_local

GitHub PR과 GitLab MR을 개인 PC에서 감시하는 학습 봇입니다. 실제 머지된 변경을 읽어 한국어 객관식 질문 두 개를 만들고, PR/MR 요약과 diff 스레드에 게시합니다. PR/MR이 닫힌 뒤에도 댓글로 답하거나 해설을 볼 수 있습니다.

## 설치와 실행

Node.js 22.13 이상(22.x 또는 24 이상), npm, Git이 필요합니다. 감시 프로세스는 포그라운드에서 실행됩니다. 별도 서버, 공개 웹훅 주소, Docker와 외부 DB 서비스 없이 설치할 수 있습니다.

```sh
npm install
npm pack
npm install -g ./heybot_local-0.2.0.tgz

# 사용자 계정으로 먼저 공식 Codex CLI에 로그인합니다.
codex login
heybot_local model codex

# GitHub CLI에 로그인한 계정의 토큰을 쓰는 예시입니다.
export GITHUB_TOKEN="$(gh auth token)"
heybot_local connect github OWNER/REPO --publisher YOUR_GITHUB_LOGIN
heybot_local doctor
heybot_local watch
```

GitLab은 `GITLAB_TOKEN`을 설정하고 `heybot_local connect gitlab GROUP/PROJECT --publisher YOUR_GITLAB_LOGIN`으로 연결합니다. 여러 저장소를 연결할 수 있습니다. 사내 포지는 `--instance`, 저장소별 토큰은 `--token-env NAME`으로 지정합니다. GitHub Enterprise에서는 REST API 기본 URL을 사용합니다. GitLab에서는 인스턴스 기본 URL을 사용합니다.

| 설정 | 토큰 권한 |
| --- | --- |
| GitHub | 지정 저장소에 대한 Contents 읽기, Pull requests 쓰기, Issues 댓글 쓰기와 collaborator 권한 조회. `requireAnswers`를 쓸 경우 Commit statuses 쓰기 |
| GitLab | `api` 범위와 프로젝트의 MR·노트·디스커션·Git 읽기 권한. 상태를 게시할 계정은 Developer 이상 |
| 댓글 사용자 | GitHub Write 또는 그 이상, GitLab Developer 또는 그 이상 |

`heybot_local status`는 감시 여부, 커서, 작업과 알림 상태, 실패 사유를 표시합니다. 기본 폴링 간격은 60초이며 `watch --interval 30`으로 변경할 수 있습니다. `watch --once`는 한 번 조회하고 실행 가능한 대기 작업을 처리합니다. `Ctrl+C`로 감시를 종료한 뒤 `connect` 또는 `model`로 설정을 바꾸고 `watch`를 다시 시작합니다.

## 설정 진단

`heybot_local doctor`는 현재 프로필의 저장소 연결과 모델을 검사합니다. 각 연결에서 토큰 인증, 게시 계정 일치 여부, 저장소 메타데이터·커밋 목록·PR/MR 목록의 API 읽기를 확인합니다. 진단은 토큰 값, API 키, 웹훅 URL과 포지 응답 본문을 표시하지 않습니다.

- **`[확인]`**은 해당 조회나 설정 검사를 통과했다는 뜻입니다. 모델은 Codex CLI의 ChatGPT 로그인, Claude Models API의 키·모델 조회, Ollama의 로컬 모델 설치 여부를 확인합니다. 웹훅은 게시 연결에 설정된 주소의 형식만 검사합니다.
- **`[메타데이터]`**는 쓰기와 관련된 권한 정보를 조회했다는 뜻입니다. GitHub는 OAuth 범위와 저장소 푸시 권한을, GitLab은 토큰의 `api` 범위와 프로젝트 역할을 사용합니다. `[확인 필요]`는 GitHub fine-grained 토큰처럼 권한 정보가 충분하지 않거나 조회할 수 없는 경우에 표시됩니다. 실제 댓글·커밋 상태 쓰기, 웹훅 수신, 모델 생성은 별도로 확인해야 합니다. 커밋 상태 쓰기는 `requireAnswers`를 사용할 때 필요합니다. [GitHub OAuth 범위](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) · [GitLab 역할과 권한](https://docs.gitlab.com/user/permissions/)
- **`[실패]`**가 있으면 종료 코드는 `1`입니다. `[확인 필요]`와 `[선택 기능]`은 종료 코드에 영향을 주지 않습니다. `[선택 기능]`은 `requireAnswers`에 필요한 권한 부족을 표시합니다. 관찰 모드에서는 게시 계정 일치, 쓰기 권한과 웹훅 검사를 건너뜁니다.

진단 중에는 포지와 모델 설정을 조회합니다. 댓글 게시, 커밋 상태 갱신, 웹훅 발송, 모델 생성 요청은 수행하지 않습니다.

## 모델

| 선택 | 설정 | 인증 |
| --- | --- | --- |
| Codex | `heybot_local model codex [--model ID]` | 사용자가 공식 CLI에서 끝낸 ChatGPT 로그인 |
| Claude | `heybot_local model claude --model ID [--key-env NAME]` | Claude Platform API 키. 기본 변수 `ANTHROPIC_API_KEY` |
| Ollama | `heybot_local model ollama --model ID [--url URL] [--context TOKENS]` | 로컬에 설치된 모델. 기본 주소 `http://127.0.0.1:11434`, 문맥 16,384 토큰 |

Claude Code의 개인 로그인과 달리, 이 npm 도구가 자동으로 요청을 보내는 방식에 Claude 구독 인증을 적용할 수 있는지는 확인되지 않았습니다. Claude 경로는 공식 Messages API 키를 사용합니다. Ollama는 로컬 전용 실행 시 `OLLAMA_NO_CLOUD=1 ollama serve`를 쓸 수 있습니다. 선택한 모델 실패 시 출력과 상태에 사유가 표시되며 다른 제공자로 넘어가지 않습니다. [Codex CLI](https://developers.openai.com/codex/noninteractive/) · [Claude 인증 조건](https://code.claude.com/docs/en/legal-and-compliance) · [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama 로컬 실행](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)

포지 토큰, 모델 API 키, 협업 웹훅 URL을 서로 다른 환경 변수로 관리합니다. 작업 트리를 체크아웃하지 않고 고정된 Git 객체를 읽습니다. 알려진 비밀 패턴과 설정한 인증 값, 민감 파일과 정책 제외 경로를 걸러낸 뒤 모델에 코드 발췌와 diff를 전달합니다. 리포지토리의 스크립트와 훅을 실행하지 않습니다. 비표준 형식의 하드코딩된 비밀은 필터를 통과할 수 있습니다.

## 댓글 명령

| 명령 | 동작 |
| --- | --- |
| `/hey help` | 사용법 표시 |
| `/hey answer Q1 B Q2 C` | 여러 문항 채점. 선택지 뒤에 근거를 추가할 수 있으며, `Q-…` 질문 ID도 접수 |
| `/hey showanswer` | 답글을 남긴 질문 스레드의 해설 표시 |
| `/hey whatelse` | 현재 변경의 심화 질문 |
| `/hey csinterview` | 변경과 관련된 CS 면접 질문 |
| `/hey morecs` | 최근 면접 질문에 대한 꼬리 질문 |
| `/hey tryagain` | 현재 코드 버전에서 질문 재생성 |
| `@hey 질문` | 고정 코드 근거에 바탕을 둔 답변 |

`/reviewbot`과 `@reviewbot` 별칭을 지원합니다. 한 문항이 있는 인라인 스레드에서는 보기 글자만 답할 수 있습니다. GitHub에서 해설을 보려면 일반 PR 댓글 대신 인라인 질문에 답글을 달아야 합니다.

기준 브랜치의 `.hey.yaml`은 `exclude`, `pathInstructions`, `maxInlineComments`, `requireAnswers`를 지원합니다. GitHub 병합 SHA만으로 여러 커밋의 squash와 rebase를 구분하기 어려운 경우에는 검증된 공통 조상에서 정책을 읽습니다. GitHub와 GitLab에서 머지 전 답변을 요구하려면 열린 PR/MR에 `/hey tryagain`으로 질문을 요청합니다. `requireAnswers: true`이면 답변에 따라 head 커밋의 `codereviewbot/questions`가 pending에서 success로 바뀝니다. 실제 차단은 포지 설정에서 이 상태를 필수로 지정해야 합니다.

## GitHub·GitLab 협업 알림

저장소별 선택 기능이며 처음에는 꺼져 있습니다. 원하는 서비스에서 Incoming Webhook을 만들고 해당 환경 변수에 URL을 설정합니다.

```sh
heybot_local connect github OWNER/REPO --publisher YOUR_GITHUB_LOGIN --notify slack
heybot_local connect gitlab GROUP/PROJECT --publisher YOUR_GITLAB_LOGIN --notify discord
```

| `--notify` | 기본 환경 변수 | 채널 지정 |
| --- | --- | --- |
| `slack` | `SLACK_WEBHOOK_URL` | Slack의 웹훅 생성 화면 |
| `mattermost` | `MATTERMOST_WEBHOOK_URL` | 웹훅 기본 채널 또는 `--notify-channel NAME` |
| `discord` | `DISCORD_WEBHOOK_URL` | Discord의 웹훅 생성 화면 |
| `webhook` | `HEYBOT_WEBHOOK_URL` | 별도 수신기에서 처리 |

`--notify-url-env NAME`으로 주소를 읽을 변수 이름을 지정할 수 있습니다. 알림을 모두 끄려면 `--notify` 없이 저장소를 다시 연결합니다.

두 포지에서 `--notify-events`에 보낼 이벤트를 쉼표로 구분해 지정할 수 있습니다. 아래 예시는 머지, 댓글, 질문 준비 알림을 보내고 댓글 미리보기를 끕니다.

```sh
heybot_local connect github OWNER/REPO --publisher YOUR_GITHUB_LOGIN --notify slack \
  --notify-events merged,commented,questions --no-notify-comment-preview
heybot_local connect gitlab GROUP/PROJECT --publisher YOUR_GITLAB_LOGIN --notify discord \
  --notify-events merged,commented,questions --no-notify-comment-preview
```

| 이벤트 | 알림 내용 |
| --- | --- |
| `opened`, `reopened`, `merged`, `closed` | PR/MR 열기, 재열기, 머지, 닫기 |
| `commented` | 일반·리뷰 댓글 또는 디스커션의 사람 댓글 |
| `questions` | 질문 준비 |
| `push` | 기존 브랜치에 커밋 Push |
| `branch-created` | 새 브랜치 생성 |

두 옵션을 생략하면 기존 저장소 설정과 마찬가지로 모든 이벤트를 보내고 댓글 첫 줄을 표시합니다. `--no-notify-comment-preview`를 지정하면 댓글 알림에 작성자, PR/MR 제목과 댓글 링크가 표시됩니다. 질문 게시와 댓글 명령은 알림 설정과 독립적으로 동작합니다.

같은 알림 대상으로 다시 연결해도 전송 이력과 조회 커서는 이어집니다. 이벤트 선택에서 제외된 대기 알림은 `skipped`로 표시합니다. 이벤트를 다시 선택하면 기록된 이벤트 시각이 재활성화 시각보다 늦을 때부터 전송합니다. 미리보기를 끄면 이미 대기 중인 댓글 알림에서도 미리보기를 제거합니다. 미리보기를 다시 켜면 이후 대기열에 들어오는 댓글부터 미리보기를 표시합니다.

일반 웹훅은 `version`, `id`, `event`, `repository`, Markdown `text`를 JSON POST로 보냅니다. 기존 브랜치 Push와 새 브랜치 생성의 `event` 값은 모두 `push`입니다. 변경 요청 번호는 GitHub에서 `pullRequest`, GitLab에서 `mergeRequest` 필드를 사용합니다. [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks) · [Discord Webhook API](https://docs.discord.com/developers/resources/webhook)

## 운영과 복구

- **게시 담당 PC**를 저장소마다 한 대 지정합니다. 게시 모드의 토큰 계정은 `--publisher`와 일치해야 합니다. 다른 PC는 `connect … --observe`로 설정합니다. 한 프로필 안에서는 잠금으로 동시 실행을 막습니다. 서로 다른 PC의 게시 모드를 원격에서 잠그는 기능은 없으므로 두 PC에서 게시 모드를 켜면 중복 가능성이 있습니다.
- 질문과 답변 이력, 대기 작업, 커서는 `HEYBOT_HOME`(기본 `~/.heybot_local`)의 SQLite와 설정 파일에 저장됩니다. 담당 PC가 바뀌면 기존 감시를 종료하고 프로필을 이관한 뒤 이전과 동일한 게시 계정으로 시작합니다.
- 첫 조회 시각부터 이벤트를 처리합니다. 이후 절전이나 연결 장애가 생기면 저장된 커서부터 다시 조회하고 작업 ID로 중복을 제거합니다. 댓글 쓰기 응답이 사라지면 재시도 전에 원격 마커를 대조합니다. 실패 작업은 `heybot_local retry JOB_ID`로 다시 대기열에 넣을 수 있습니다. 협업 웹훅 응답이 유실되면 해당 알림은 `uncertain`으로 표시됩니다.
- GitHub는 PR 타임라인과 저장소 활동 API를 사용합니다. Push 활동의 재조회 구간은 마지막 커서보다 15분 전까지 겹칩니다. 머지·머지 큐 활동은 PR 머지 알림으로 처리합니다. 강제 Push의 이전 SHA가 사라졌거나 비교 범위가 너무 크면 브랜치 링크와 범위 상태를 남깁니다. 저장소 활동 API가 제공되지 않는 인스턴스에서는 Push·새 브랜치 조회 오류가 감시 출력에 표시됩니다. [GitHub 타임라인](https://docs.github.com/en/rest/issues/timeline) · [GitHub 저장소 활동](https://docs.github.com/en/rest/repos/repos#list-repository-activities)
- GitLab의 과거 MR은 배치로 순회하므로 변경 시각이 갱신되지 않는 옛 MR의 댓글은 감지까지 여러 번 폴링이 걸릴 수 있습니다. 재열기 이력이 없는 GitLab 인스턴스에서는 두 폴링 사이에 일어난 연속 상태 전이가 누락될 수 있습니다. Push 보존 기간을 넘겼거나 GitLab bulk 이벤트가 브랜치·SHA를 생략하면 전체 Push를 복원할 수 없습니다. 확인할 수 없는 범위는 알림 큐에 표시됩니다.

## 검증

`npm test`는 격리 HTTP·Git 서버와 모델 응답으로 양쪽 포지의 CLI 흐름을 검증합니다. 실제 연동 결과는 아래 표에 함께 기록합니다.

| 항목 | 검증 범위 |
| --- | --- |
| 설치 패키지 | `npm pack`으로 만든 tarball을 깨끗한 npm 디렉터리에 설치. macOS에서 Node 22.23.5 및 26.0.0으로 CLI와 양쪽 포지의 격리 머지→질문→답변·해설 확인 |
| 폴링과 복구 | 두 댓글 표면, 페이지네이션과 429 후 재개, 응답 유실 후 마커 대조, SQLite 이력, 전용 게시자와 관찰자 |
| 모델 | 공식 Codex CLI 0.169.0과 ChatGPT 로그인으로 한국어 질문 생성과 근거 채점 확인. Claude API 구조화 출력 및 Ollama 출제·채점은 격리 응답으로 검증. 실행 중인 Ollama와 테스트용 Claude API 키가 없어 두 모델의 실제 호출은 미검증 |
| GitHub | 사용자 승인 테스트 저장소에서 설치 패키지로 검증. PR #1의 실제 머지, 요약 1개와 인라인 질문 2개, 같은 계정의 복수 답변과 근거 채점, 문항별 인라인 해설. PR #2에서 `requireAnswers`의 pending→success와 닫힌 PR의 도움말 확인. [머지 PR](https://github.com/thisis-joe/heybot_local/pull/1) · [채점](https://github.com/thisis-joe/heybot_local/pull/1#issuecomment-7186399720) · [스레드 해설](https://github.com/thisis-joe/heybot_local/pull/1#discussion_r4705494257) · [답변 상태 PR](https://github.com/thisis-joe/heybot_local/pull/2) |
| GitLab | 격리된 MR·디스커션·커밋 상태와 알림 테스트. 공개 GitLab 프로젝트에서 목록 및 Push 이벤트 응답 확인. 사용자 인증이 필요한 실제 GitLab MR 게시·상태는 미검증 |
| 협업 알림 | 두 포지에서 변경 요청·댓글·질문·Push·새 브랜치와 네 웹훅 전송 형식을 격리 검증했습니다. 실제 GitHub 저장소의 재열기·닫기·댓글·브랜치 생성·Push 5건도 로컬 수신기에서 확인했습니다. 재조회 시 추가 전송은 0건이었습니다. [테스트 댓글](https://github.com/thisis-joe/heybot_local/pull/2#issuecomment-7186672328) · [테스트 브랜치](https://github.com/thisis-joe/heybot_local/tree/verify/heybot-local-notifications) |
| 알림 제어 | GitHub·GitLab 격리 CLI에서 이벤트 선택, 재활성화와 중복 방지, 댓글 미리보기의 대기열 제거, 질문 게시와 댓글 명령을 확인했습니다. |

실연동은 공개 `heybot_local` 저장소의 테스트 브랜치와 합성 코드에 한정했습니다.

## 범용 배포에서 확인할 항목

| 항목 | 현재 지원 범위와 남은 확인 |
| --- | --- |
| 운영체제와 포지 | macOS에서 Node 22·26과 GitHub.com을 실검증했습니다. Linux·Windows의 설치·종료 동작, 비공개 GitLab, GitHub Enterprise 및 사내 CA 환경의 실연동 결과가 필요합니다. |
| 최초 설정 | `doctor`로 토큰·저장소 읽기와 권한 메타데이터, 모델·웹훅 설정을 점검할 수 있습니다. 댓글·커밋 상태 쓰기와 웹훅 수신은 실제 작업에서 확인합니다. |
| 모델 인증 | Codex ChatGPT 로그인, Claude API 키, 로컬 Ollama를 설정할 수 있습니다. Claude 구독과 Ollama·Claude 유료 API의 실제 실행 범위는 검증 표를 참고합니다. |
| 알림 관리 | 저장소마다 알림 대상 한 곳, 이벤트 종류와 댓글 미리보기 표시 여부를 설정할 수 있습니다. 실제 협업 채널에서 설정 전환과 수신을 확인할 항목이 남아 있습니다. |
| 계속 실행과 인계 | 지정 PC가 꺼져 있는 동안엔 게시가 멈추고 재시작 시 커서에서 복구합니다. 다른 PC에 맡길 때는 프로필과 게시 계정 이관이 필요합니다. |


[기능 대조표와 원본 기준 커밋](docs/specs/heybot-local.md) · [구현 순서](docs/plans/heybot-local.md)

MIT. `codereviewbot`에서 가져온 코드 및 테스트의 원본 저작권 표기를 [LICENSE](LICENSE)에 보존했습니다.
