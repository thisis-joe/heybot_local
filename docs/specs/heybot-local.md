# heybot_local 기능 명세

기준은 `codereviewbot@70f744c705006603598f94046e4cefae8874dc9d`다. `README.md`는 사용자 동작, `docs/connections.md`는 권한과 실연동 시나리오, `docs/operations.md`는 복구와 Mattermost의 기준으로 삼는다. 아래 코드와 테스트 경로는 이 커밋을 기준으로 한다. 원본 작업 트리는 읽기 전용으로 유지한다. 복사한 소스와 테스트에는 원본 MIT 라이선스와 우동균 저작권 표기를 적용한다.

| 기능 | 기존 근거 | 로컬 이벤트와 권한 | 완료 확인 |
| --- | --- | --- | --- |
| 자동 질문 2개와 요약·인라인 | README 사용법, connections §5, `controller.ts`, `review.ts`, `publish.ts`, `merge-trigger`·`question-generation`·`publish` 테스트 | 양쪽 Pull/MR API의 실제 merged 시각과 상태. Contents 읽기, PR/MR 댓글 쓰기. 원본 head/base/start SHA와 diff 위치 고정 | 첫 조회 및 열린·닫힌·재열린 PR/MR과 일반 Push에서 미출제. 머지 fixture에서 한국어 선택형 두 문항, 요약과 인라인, 답안 비공개 |
| 도움말과 호환 명령 | README 댓글 명령, `commands.ts`, `commands` 테스트 | GitHub 저장소 일반·리뷰 댓글, GitLab MR 노트·디스커션. 작성자의 write/Developer 이상 | `/hey help`, `/reviewbot`, `@reviewbot`, 잘못된 인자와 제거된 명령, 닫힌 대상 테스트 |
| 답변과 해설 | connections 질문 댓글별 해설, `learning-command.ts`, `question-thread.ts`, `render.ts`, `thread-reveal`·`basic-explanations`·`learning` 테스트 | 댓글 스레드 식별자를 보존. GitHub 일반 댓글은 최상위 게시. GitLab은 토론의 답변 경로 사용 | `/hey answer`, 기존 Q 해시 ID, 번호, 복수 문항과 이유 채점, 보기 한 글자, `/hey showanswer`의 스레드 범위와 구버전 거부 |
| 추가 학습과 질문 | README CS 기술 면접, `csinterview.ts`, `whatelse.ts`, `controller.ts`, `commands`·`morecs`·`csinterview` 테스트 | 권한 있는 댓글에서 `whatelse`, `csinterview`, `morecs`, `tryagain`, `@hey`. 같은 버전에 출제 이력 보존 | 추가 질문과 면접/꼬리 번호, 재생성, 근거 위치 검증, 게시 재시도에서 저장 결과 재사용 |
| 정책과 답변 상태 | README 저장소 설정, connections 답변 완료 후 머지, `policy.ts`, `answer-gate.ts`, `answer-gate` 테스트 | 대상의 고정 기준 SHA에서 `.hey.yaml` 읽기. Commit statuses 쓰기/GitLab Developer 이상 | 현재 커밋에 필요한 답변 수를 상태로 쓰고 답변 완료 시 성공. 머지 전에는 명시적 `tryagain`으로 출제 요청 가능 |
| GitHub·GitLab 협업 알림 | operations Mattermost, `mattermost.ts`, `mattermost` 테스트 | GitHub PR 목록·타임라인·일반/리뷰 댓글·저장소 활동. GitLab MR 목록·상태 이력·노트/디스커션·프로젝트 이벤트. 양쪽에서 질문 게시 큐와 커밋 비교를 사용한다. 개인 설정의 Mattermost·Slack·Discord·일반 웹훅 | 열기·재열기·머지·닫기, 사람 댓글과 질문 준비, Push·새 브랜치 메시지. 누락된 push 범위는 분리 집계 |
| 재시작 및 게시 책임 | operations 중복과 장애, `store.ts`, `publish.test.mjs` | 로컬 SQLite 트랜잭션으로 커서와 큐를 함께 확정. 인증 계정 검사와 저장소마다 지정 PC 한 대만 게시. 동일 프로필 동시 실행 잠금 | 페이지 경계, 429, 중단 후 재개, 쓰기 응답 유실 후 마커 대조. 같은 계정의 사람 명령과 출력 구분 |
| 모델 선택 | connections 모델 연결, `codex.ts`, `claude.ts`, `contracts.ts` | 공식 Codex CLI의 사용자 로그인, Claude 공식 Messages API 키, 로컬 Ollama 구조화 출력. 선택된 어댑터만 호출 | 각 어댑터의 구조화 결과와 실패 검사. 인증된 제공자 또는 실저장소 증거가 없는 항목은 README에 남김 |

## 선행 검증과 설계 결정

- GitHub 일반·리뷰 댓글은 저장소 단위 `since`를 사용한다. 일반 댓글의 이슈 번호는 PR 상세 조회로 검증한다. 머지 판단은 업데이트된 PR 목록과 실제 머지 시각을 사용한다. [일반 댓글](https://docs.github.com/en/rest/issues/comments) · [리뷰 댓글](https://docs.github.com/en/rest/pulls/comments) · [PR](https://docs.github.com/en/rest/pulls/pulls)
- GitLab은 업데이트된 MR을 먼저 조회하고 과거 MR도 순회한다. MR 수정 시각이 모든 토론 댓글에 대해 갱신된다는 계약이 없어 과거 대상의 노트와 디스커션을 재조회한다. 재열기는 MR의 상태 이력에서 개설 이후의 `opened` 전이를 확인한다. 인스턴스가 해당 이력을 반환하지 않으면 관찰된 closed → opened 전이까지만 확인할 수 있다. [MR](https://docs.gitlab.com/api/merge_requests/) · [디스커션](https://docs.gitlab.com/api/discussions/) · [상태 이력](https://docs.gitlab.com/api/resource_state_events/)
- GitLab 프로젝트 이벤트에서 branch, before/after SHA, 작성자를 읽고 straight compare와 부모 수로 Push를 렌더링한다. 이벤트 보존 기간을 넘긴 이력이나 브랜치와 SHA를 생략하는 bulk push는 완전 복구가 불가능하다. 불완전한 이벤트는 기록한다. [프로젝트 이벤트](https://docs.gitlab.com/api/events/) · [compare](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits)
- 같은 저장소에서는 게시 계정과 PC 한 대를 팀에서 지정한다. 다른 PC는 읽기 전용으로 설정한다. API의 댓글 생성에는 공통 선점 키가 없어 마커 확인과 생성만으로 두 PC의 동시 쓰기를 막을 수 없다. 게시 PC를 바꿀 때 기존 감시를 종료하고 로컬 데이터와 커서를 이관한다. 포지 권한 조회와 게시 토큰을 모델 인증에 사용하지 않는다.
- 현 PC의 Codex CLI 0.169.0과 ChatGPT 로그인 상태, Claude Code 2.1.332의 print/JSON 스키마 옵션을 확인했다. Claude Code의 일반 사용자 로그인과 별개로 이 도구의 자동 호출에 Claude 구독 적용은 확인되지 않아 Claude는 API 키 경로를 사용한다. Ollama는 루프백 API의 스키마 출력을 요청한다. [Codex 자동화](https://developers.openai.com/codex/noninteractive/) · [Claude 인증 조건](https://code.claude.com/docs/en/legal-and-compliance) · [Claude 구조화 출력](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs)
- 코드와 정책은 고정 SHA에서 읽고 민감 경로와 인증 정보를 제거한다. 저장소 스크립트, 훅, 체크아웃 및 모델 실행 도구는 사용하지 않는다. 코드 위치와 스키마를 검증한 결과만 게시한다.

## 인수 기준

설치된 tarball의 CLI에서 connect, model, watch, status가 동작해야 한다. 같은 설치의 격리 서버에서 머지부터 답변과 해설까지 확인하고, 플랫폼·모델별 실검증 여부를 README에 표기한다. 런타임은 Node와 로컬 저장 공간을 사용한다. 별도의 서버, 공개 웹훅, DB 서비스나 npm 공개 발행은 필요하지 않다.

알림은 저장소별 선택 기능이다. Mattermost는 기존 형식을 유지하고 Slack, Discord, 일반 웹훅도 선택할 수 있다. 사용자가 제공한 웹훅 환경 변수로 설정하며, 개발 검증에는 격리된 수신기를 사용한다. [Slack](https://api.slack.com/messaging/webhooks) · [Discord](https://docs.discord.com/developers/resources/webhook)

GitHub 알림은 PR 열기·재열기·머지·닫기, 일반·리뷰 댓글, 질문 준비, 브랜치 Push·생성을 지원한다. 실제 PR 머지만 자동 출제의 신호다. 활동 API의 커서 페이지와 커밋 범위를 분리해 조회한다. PR 머지와 머지 큐의 활동은 PR 머지 알림으로 처리한다. GitLab 기존 출력과 웹훅 JSON의 `mergeRequest` 필드는 유지한다. GitHub 웹훅에서는 `pullRequest`와 브라우저용 링크를 보낸다. [GitHub 타임라인](https://docs.github.com/en/rest/issues/timeline) · [GitHub 저장소 활동](https://docs.github.com/en/rest/repos/repos#list-repository-activities)
