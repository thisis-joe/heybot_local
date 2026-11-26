# heybot_local 구현 순서

[기능 명세](../specs/heybot-local.md)를 기준으로 순서대로 진행하고 각 기능 브랜치의 작업 단위를 커밋한다.

| 단계 | 선행 | 브랜치 | 확인 |
| --- | --- | --- | --- |
| 1. 설치부터 GitHub 답변까지 | 기능 조사 | `feat/local-runtime` | 모델·CLI·SQLite 연결. 머지/댓글 조회, 질문 게시 및 해설. 기존 로직 회귀 |
| 2. GitLab과 복구·알림 | 1 | `feat/gitlab-notifications` | 두 플랫폼 댓글, 장애 복구, lifecycle·Push·Mattermost 및 권한·상태 검사 |
| 3. 패키지 설치 및 연동 기록 | 2 | `feat/package-verification` | npm pack 설치, 격리 E2E, 허가된 실연동 범위와 남은 항목을 README에 기록 |

운영 저장소나 npm 레지스트리에 변경을 게시하는 작업은 별도 요청으로 진행한다.
