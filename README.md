# heybot_local

GitHub PR과 GitLab MR이 머지되면 **변경을 이해했는지 확인하는 한국어 객관식 두 문항**을 게시합니다. PR/MR 댓글로 답을 내거나, 헷갈리는 문항의 해설을 볼 수 있습니다. 봇은 내 PC에서 실행되고, 나는 Codex·Claude·Ollama 중 사용할 모델을 고릅니다.

## 빠른 시작

Node.js 22.13 이상(22.x 또는 24 이상), npm, Git을 설치해 주세요. 별도 서버나 공개 웹훅 없이 사용할 수 있습니다.

### 1. 설치

```sh
npm install -g heybot_local
heybot_local --help
```

Windows PowerShell에서 npm 스크립트 실행이 차단되면 `npm.cmd install -g heybot_local`과 `heybot_local.cmd --help`를 실행하세요. 소스에서 설치하려면 저장소를 받은 뒤 `npm ci`, `npm pack`, `npm install -g ./heybot_local-0.3.0.tgz` 순으로 실행합니다.

### 2. 모델 고르기

아래 셋 중 하나만 설정하면 됩니다. `MODEL_ID`는 사용하려는 모델 이름으로 바꾸세요.

| 모델 | 먼저 준비할 것 | 설정 명령 |
| --- | --- | --- |
| Codex | 공식 Codex CLI를 설치하고 `codex login`으로 ChatGPT에 로그인 | `heybot_local model codex` |
| Claude | Claude Platform API 키를 `ANTHROPIC_API_KEY` 환경 변수로 설정 | `heybot_local model claude --model MODEL_ID` |
| Ollama | Ollama를 실행하고 `ollama list`에서 설치된 로컬 모델 이름 확인 | `heybot_local model ollama --model MODEL_ID` |

Claude는 Platform API 키로 과금됩니다. Codex는 CLI에 로그인한 계정을 사용하고, Ollama는 기본적으로 내 PC의 `127.0.0.1:11434`에 연결합니다. [Codex 로그인](https://developers.openai.com/codex/auth/) · [Claude API](https://platform.claude.com/docs/en/api/overview) · [Ollama 시작하기](https://docs.ollama.com/quickstart)

### 3. 저장소 연결하기

`OWNER/REPO` 또는 `GROUP/PROJECT`는 저장소 주소의 경로입니다. `--publisher`에는 토큰을 발급받은 계정의 로그인 이름을 넣으세요.

**GitHub**에서 이미 GitHub CLI를 쓰고 있다면 `gh auth login` 후 같은 터미널에서 실행하세요. GitHub CLI 없이 발급한 토큰도 `GITHUB_TOKEN` 환경 변수에 설정해 사용할 수 있습니다.

```sh
export GITHUB_TOKEN="$(gh auth token)"
heybot_local connect github OWNER/REPO --publisher MY_GITHUB_LOGIN
```

PowerShell의 토큰 설정은 `$env:GITHUB_TOKEN = (gh auth token)`입니다.

**GitLab**에서는 `api` 범위가 있는 토큰을 `GITLAB_TOKEN` 환경 변수에 설정한 뒤 실행하세요.

```sh
heybot_local connect gitlab GROUP/PROJECT --publisher MY_GITLAB_LOGIN
```

게시 계정에는 저장소 읽기와 PR/MR 댓글 쓰기 권한이 필요합니다. 같은 저장소를 팀에서 함께 쓴다면 **게시를 담당할 PC 한 대**를 정하세요. 다른 PC는 연결 명령 끝에 `--observe`를 붙이면 게시 없이 감시할 수 있습니다. 토큰 권한, 사내 주소, 인증서 설정은 [운영 가이드](docs/operations.md#저장소-연결과-권한)에 정리했습니다.

### 4. 점검하고 감시 시작하기

```sh
heybot_local doctor
heybot_local watch
```

`doctor`는 현재 계정, 저장소 읽기, 권한 정보, 모델, 웹훅 설정을 조회합니다. `[실패]`가 있으면 표시된 항목부터 해결하세요. `[확인 필요]`나 `[메타데이터]`가 붙은 쓰기 권한은 실제 게시로 확인해야 합니다.

`watch`를 시작한 뒤 작은 PR/MR을 하나 머지해 보세요. 이전 머지는 건너뜁니다. 기본 조회 간격은 60초입니다. 새 머지를 찾으면 모델이 생성한 질문을 PR/MR 요약과 인라인 스레드에 게시합니다. 감시를 멈출 때는 `Ctrl+C`, 다른 터미널에서 상태를 볼 때는 `heybot_local status`를 사용합니다.

## PR/MR 댓글에서 사용하기

| 이렇게 쓰세요 | 동작 |
| --- | --- |
| `/hey help` | 사용 가능한 명령 보기 |
| `/hey answer Q1 B Q2 C` | 여러 문항에 답하기. 보기 뒤에 근거를 적을 수도 있습니다. |
| `/hey showanswer` | 질문 스레드에 답글로 남겨 해당 문항 해설 보기 |
| `/hey whatelse` | 이번 변경의 심화 질문 요청 |
| `/hey csinterview` · `/hey morecs` | 변경과 관련된 CS 면접 질문과 꼬리 질문 요청 |
| `/hey tryagain` | 현재 코드 기준으로 새 질문 요청 |
| `@hey 이 지점에서 왜 캐시를 지우나요?` | 변경 코드에 관한 질문 |

한 문항만 있는 인라인 스레드에서는 `B`처럼 보기 글자만 답해도 됩니다. GitHub에서 해설을 보려면 인라인 질문에 답글을 다세요. 명령을 쓰려는 사람에게는 GitHub Write 또는 GitLab Developer 이상의 역할이 필요합니다.

## 팀 채널에 알림 받기

GitHub와 GitLab 모두에서 저장소별로 Slack, Mattermost, Discord, 일반 웹훅 중 한 곳을 지정할 수 있습니다. 서비스에서 발급한 Incoming Webhook URL을 해당 환경 변수에 설정하세요.

| 서비스 | `--notify` | 환경 변수 |
| --- | --- | --- |
| Slack | `slack` | `SLACK_WEBHOOK_URL` |
| Mattermost | `mattermost` | `MATTERMOST_WEBHOOK_URL` |
| Discord | `discord` | `DISCORD_WEBHOOK_URL` |
| 일반 웹훅 | `webhook` | `HEYBOT_WEBHOOK_URL` |

예를 들어 Slack에서 머지와 질문 준비 알림만 받으려면 감시를 멈춘 뒤 다음 명령으로 다시 연결하고 `watch`를 시작하세요.

```sh
heybot_local connect github OWNER/REPO --publisher MY_GITHUB_LOGIN --notify slack --notify-events merged,questions
```

사람 댓글도 알리려면 이벤트에 `commented`를 추가하세요. 댓글 첫 줄을 채널에 보내지 않으려면 `--no-notify-comment-preview`를 붙입니다. 전체 이벤트와 설정 방법은 [운영 가이드](docs/operations.md#githubgitlab-협업-알림)에서 확인할 수 있습니다.

## 운영 정보

- 프로필과 SQLite 이력은 기본적으로 `~/.heybot_local`에 저장됩니다. `HEYBOT_HOME`으로 바꿀 수 있고, 감시를 다시 켜면 저장된 조회 위치부터 이어갑니다.
- 포지 토큰, 모델 키, 웹훅 주소는 각각 환경 변수로 관리합니다. 모델에는 알려진 비밀 패턴과 제외 파일을 제거한 코드 발췌를 전달합니다. 비공개 코드의 외부 전송 기준과 팀 채널에 표시할 내용은 팀 정책에 따라 설정하세요.
- 기준 브랜치의 `.hey.yaml`로 제외 경로, 인라인 질문 수, 선택 기능인 `requireAnswers`를 설정할 수 있습니다. [저장소 정책과 장애 복구](docs/operations.md)
- macOS와 Linux ARM64에서 설치와 실행을 검증했습니다. Windows 네이티브와 실제 사내 GitHub Enterprise·비공개 GitLab은 추가 검증 범위입니다. [검증 결과와 재현 절차](docs/verification.md)

[기능 대조표와 원본 기준 커밋](docs/specs/heybot-local.md) · [개발 순서](docs/plans/heybot-local.md) · [MIT 라이선스와 원본 저작권](LICENSE)
