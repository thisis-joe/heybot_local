# 운영 가이드

[빠른 시작](../README.md)에서 설치와 첫 연결을 할 수 있습니다.

## 저장소 연결과 권한

| 사내 포지 | `--instance` 예시 | 인증과 Git 경로 |
| --- | --- | --- |
| GitHub Enterprise Server | `https://github.example.com/api/v3` | REST는 Bearer 토큰을 사용합니다. Git은 토큰을 HTTPS 비밀번호로 사용해 `https://github.example.com/OWNER/REPO.git`을 읽습니다. [GitHub REST 가이드](https://docs.github.com/en/enterprise-server@3.19/rest/using-the-rest-api/getting-started-with-the-rest-api) |
| GitHub Enterprise Cloud (GHE.com) | `https://api.TENANT.ghe.com` | REST와 웹 호스트가 다릅니다. Git은 `https://TENANT.ghe.com/OWNER/REPO.git`을 읽습니다. [GHE.com REST 가이드](https://docs.github.com/en/enterprise-cloud@latest/rest/using-the-rest-api/getting-started-with-the-rest-api) |
| GitLab Self-Managed | `https://git.example.com/gitlab` | `GROUP/SUBGROUP/PROJECT`도 연결할 수 있습니다. REST는 `/gitlab/api/v4`와 `PRIVATE-TOKEN` 헤더를 사용합니다. Git은 토큰을 HTTPS 비밀번호로 사용해 `/gitlab/GROUP/SUBGROUP/PROJECT.git`을 읽습니다. [GitLab 경로 접두어](https://docs.gitlab.com/install/relative_url/) · [토큰 인증](https://docs.gitlab.com/user/profile/personal_access_tokens/) |

사내 CA를 쓰면 신뢰할 PEM 번들의 절대 경로를 Node용 `NODE_EXTRA_CA_CERTS`와 Git용 `GIT_SSL_CAINFO`에 각각 설정한 셸에서 CLI를 시작합니다. Git for Windows의 CA 번들 처리는 TLS 백엔드에 따라 달라집니다. 인증서와 호스트 이름 검사는 유지됩니다. [Node 인증서 설정](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html#node_extra_ca_certsfile) · [Git 인증서 설정](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpsslCAInfo)

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

## 저장소 정책

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
