import { readConfig, sameLogin, type Config, type ModelConfig, type RepositoryConfig } from './config.js';
import { HttpError } from './http-client.js';
import { ModelFailure } from './model-failure.js';
import { checkClaudeModel, checkCodexLogin, checkOllamaModel } from './models.js';
import { webhookUrl } from './notifications.js';
import { Platform } from './platform.js';
import { redact } from './redact.js';

type Level = '확인' | '메타데이터' | '확인 필요' | '실패' | '건너뜀';
type Report = (level: Level, label: string, detail: string) => void;
type Display = (label: string) => string;
type Account = Awaited<ReturnType<Platform['account']>>;
interface RepositoryMetadata {
  id: number;
  archived?: boolean;
  visibility?: string;
  private?: boolean;
  permissions?: { push?: boolean; project_access?: { access_level?: number }; group_access?: { access_level?: number } };
}

const writePending = '실제 쓰기 확인 필요';

export async function doctor(dir: string): Promise<number> {
  const config = await readConfig(dir).catch(() => undefined);
  if (!config) {
    console.error('[실패] 설정 파일 — config.json을 읽고 형식을 확인하세요.');
    return 1;
  }
  const display = displayLabels(config);
  let failed = false;
  const report: Report = (level, label, detail) => {
    if (level === '실패') failed = true;
    console.log(`[${level}] ${label} — ${detail}`);
  };
  if (!config.repositories.length) report('실패', '연결', '먼저 connect로 저장소를 연결하세요.');
  for (const [index, repo] of config.repositories.entries()) {
    console.log(`\n연결 ${index + 1} · ${repo.platform} ${display(repo.repository)} (${repo.mode})`);
    await checkConnection(repo, report, display);
  }
  await checkModel(config.model, config.repositories.some(repo => repo.mode === 'publish'), report, display);
  return failed ? 1 : 0;
}

function displayLabels(config: Config): Display {
  const names = config.repositories.flatMap(repo => [repo.tokenEnv, repo.notifications?.urlEnv]);
  if (config.model?.provider === 'claude') names.push(config.model.keyEnv);
  const secrets = names.map(name => name && process.env[name]?.trim()).filter((value): value is string => Boolean(value));
  return label => secrets.some(value => label.includes(value)) ? '[가림]' : redact(label);
}

function errorDetail(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}${error.retryAt ? ' · API 요청 제한' : ''}`;
  return '연결 또는 API 응답을 확인하세요.';
}

async function checkConnection(repo: RepositoryConfig, report: Report, display: Display): Promise<void> {
  const token = process.env[repo.tokenEnv]?.trim();
  const tokenLabel = `토큰 (${display(repo.tokenEnv)})`;
  const platform = new Platform(repo, async () => token ?? '');
  let account: Account | undefined;
  if (!token) report('실패', tokenLabel, '환경 변수에 토큰을 설정하세요.');
  else {
    try {
      account = await platform.account();
      report('확인', tokenLabel, '포지 API 인증 성공');
    } catch (error) { report('실패', tokenLabel, errorDetail(error)); }
  }
  let metadata: RepositoryMetadata | undefined;
  if (!account) {
    report('건너뜀', '계정', '토큰 인증 필요');
    report('건너뜀', '저장소 읽기', '토큰 인증 필요');
  } else {
    if (repo.mode === 'observe') report('확인', '계정', '인증 계정 조회 성공 (관찰 모드)');
    else if (sameLogin(account.login, repo.botLogin)) report('확인', '게시 계정', '--publisher 계정과 일치');
    else report('실패', '게시 계정', '토큰 계정이 --publisher 계정과 다릅니다.');
    metadata = await checkRepository(platform, report);
  }

  if (repo.mode === 'observe') reportBoth(report, '건너뜀', '관찰 모드');
  else if (!account || !metadata) reportBoth(report, '확인 필요', '토큰 인증과 저장소 조회 필요');
  else if (metadata.archived === true) reportBoth(report, '실패', '보관된 저장소');
  else if (repo.platform === 'github') githubPermissions(account, metadata, report);
  else await gitlabPermissions(platform, account, metadata, report);

  checkWebhook(repo, report, display);
}

async function checkRepository(platform: Platform, report: Report): Promise<RepositoryMetadata | undefined> {
  let repo: RepositoryMetadata;
  try {
    repo = await platform.api.request(platform.root);
    if (!Number.isSafeInteger(repo?.id) || repo.id < 1) throw new Error('Invalid repository response');
    report('확인', '저장소 메타데이터', '포지 API에서 조회 성공');
  } catch (error) {
    report('실패', '저장소 읽기', errorDetail(error));
    return;
  }

  const github = platform.config.platform === 'github';
  try {
    await platform.api.page(`${platform.root}/${github ? 'commits' : 'repository/commits'}`, 1, 1);
    report('확인', '저장소 읽기', '커밋 목록 API 조회 성공');
  } catch (error) {
    if (github && error instanceof HttpError && error.status === 409)
      report('확인 필요', '저장소 읽기', 'HTTP 409 · 커밋이 있는 저장소에서 확인 필요');
    else report('실패', '저장소 읽기', errorDetail(error));
  }
  const label = github ? 'PR 목록' : 'MR 목록';
  try {
    await platform.api.page(`${platform.root}/${github ? 'pulls' : 'merge_requests'}?state=all`, 1, 1);
    report('확인', label, '포지 API에서 조회 성공');
  } catch (error) { report('실패', label, errorDetail(error)); }
  return repo;
}

function reportBoth(report: Report, level: Level, detail: string): void {
  report(level, '댓글 쓰기', detail);
  report(level, '커밋 상태 쓰기', detail);
}

function githubPermissions(account: Account, repo: RepositoryMetadata, report: Report): void {
  const scopes = account.oauthScopes?.split(',').map(scope => scope.trim()).filter(Boolean);
  if (!scopes?.length) {
    report('확인 필요', '댓글 쓰기', `토큰의 Pull requests 쓰기 권한 조회 불가 · ${writePending}`);
    report('확인 필요', '커밋 상태 쓰기', `토큰의 Commit statuses 쓰기 권한 조회 불가 · ${writePending}`);
    return;
  }
  const visibility = repo.visibility ?? (repo.private === true ? 'private' : undefined);
  const repoScope = scopes.includes('repo') || (scopes.includes('public_repo') && visibility === 'public');
  const unknownVisibility = scopes.includes('public_repo') && visibility === undefined;
  if (repoScope) report('메타데이터', '댓글 쓰기', `OAuth 권한 범위 확인 · ${writePending}`);
  else if (unknownVisibility) report('확인 필요', '댓글 쓰기', `저장소 공개 여부 확인 필요 · ${writePending}`);
  else report('실패', '댓글 쓰기', 'OAuth 토큰의 저장소 권한 범위 부족');

  if (repo.permissions?.push === false) report('실패', '커밋 상태 쓰기', '저장소 푸시 권한 부족');
  else if (repoScope || scopes.includes('repo:status')) {
    const push = repo.permissions?.push === true ? ' · 저장소 푸시 권한 확인' : ' · 저장소 푸시 권한 조회 불가';
    report('메타데이터', '커밋 상태 쓰기', `OAuth 권한 범위 확인${push} · ${writePending}`);
  } else if (unknownVisibility) report('확인 필요', '커밋 상태 쓰기', `저장소 공개 여부 확인 필요 · ${writePending}`);
  else report('실패', '커밋 상태 쓰기', 'OAuth 토큰의 커밋 상태 권한 범위 부족');
}

async function gitlabPermissions(platform: Platform, account: Account, repo: RepositoryMetadata, report: Report): Promise<void> {
  const token = await platform.api.request('/personal_access_tokens/self').catch(() => undefined);
  const scopes: unknown = token?.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string') || token.granular_scopes?.length) {
    reportBoth(report, '확인 필요', `토큰의 API 쓰기 권한 조회 불가 · ${writePending}`);
    return;
  }
  if (!scopes.includes('api')) {
    reportBoth(report, '실패', '토큰에 api 권한 범위가 없습니다.');
    return;
  }

  const member = account.id === undefined ? undefined
    : await platform.api.request(`${platform.root}/members/all/${account.id}`).catch(() => undefined);
  const levels = [member?.access_level, repo.permissions?.project_access?.access_level, repo.permissions?.group_access?.access_level];
  const access = Math.max(0, ...levels.filter((level): level is number => Number.isInteger(level)));
  report('메타데이터', '댓글 쓰기', `api 권한 범위 확인 · ${writePending}`);
  if (access >= 30) report('메타데이터', '커밋 상태 쓰기', `api 권한 범위와 Developer 이상 역할 확인 · ${writePending}`);
  else if (Number.isInteger(member?.access_level)) report('실패', '커밋 상태 쓰기', '프로젝트의 Developer 이상 역할 필요');
  else report('확인 필요', '커밋 상태 쓰기', `api 권한 범위 확인 · 프로젝트의 Developer 이상 역할 조회 불가 · ${writePending}`);
}

function checkWebhook(repo: RepositoryConfig, report: Report, display: Display): void {
  const config = repo.notifications;
  if (repo.mode === 'observe' || !config) {
    report('건너뜀', '웹훅', repo.mode === 'observe' ? '관찰 모드' : '알림 꺼짐');
    return;
  }
  const label = `웹훅 (${config.provider}, ${display(config.urlEnv)})`;
  const value = process.env[config.urlEnv]?.trim();
  if (!value) { report('실패', label, '환경 변수에 웹훅 주소를 설정하세요.'); return; }
  try {
    webhookUrl(config.provider, value);
    report('확인', label, '주소 형식 유효 · 실제 수신 확인 필요');
  } catch { report('실패', label, '웹훅 주소 형식을 확인하세요.'); }
}

async function checkModel(config: ModelConfig | undefined, publish: boolean, report: Report, display: Display): Promise<void> {
  if (!config) {
    report(publish ? '실패' : '건너뜀', '모델', publish ? '먼저 model로 제공자를 설정하세요.' : '게시 연결 없음');
    return;
  }
  const label = config.provider === 'codex' ? '모델 (Codex)' : config.provider === 'ollama'
    ? '모델 (Ollama)' : `모델 (Claude, ${display(config.keyEnv)})`;
  const generation = '실제 생성 확인 필요';
  try {
    if (config.provider === 'codex') {
      await checkCodexLogin();
      report('확인', label, `CLI의 ChatGPT 로그인 확인 · ${generation}`);
    } else if (config.provider === 'claude') {
      await checkClaudeModel(config);
      report('확인', label, `API 키와 모델 조회 확인 · ${generation}`);
    } else {
      await checkOllamaModel(config);
      report('확인', label, `설치된 로컬 모델 확인 · ${generation}`);
    }
  } catch (error) {
    const failure = error instanceof ModelFailure ? error.failure : undefined;
    const detail = config.provider === 'codex' ? 'CLI 설치와 ChatGPT 로그인 상태를 확인하세요.'
      : failure?.apiStatus ? `모델 조회 HTTP ${failure.apiStatus}`
      : failure?.code === 'authentication' ? '환경 변수에 API 키를 설정하세요.'
      : failure?.code === 'model_unavailable' ? '선택한 모델을 찾을 수 없습니다.' : '모델 주소 또는 연결을 확인하세요.';
    report('실패', label, detail);
  }
}
