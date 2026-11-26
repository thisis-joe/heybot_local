import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const repository = z.string().regex(/^[\w.-]+(?:\/[\w.-]+)+$/)
  .refine(value => value.split('/').every(part => part !== '.' && part !== '..'));
export const ModelConfigSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('codex'), model: z.string().min(1).optional() }),
  z.strictObject({ provider: z.literal('claude'), model: z.string().min(1), keyEnv: envName.default('ANTHROPIC_API_KEY') }),
  z.strictObject({ provider: z.literal('ollama'), model: z.string().min(1), context: z.number().int().min(2048).max(131072).default(16384), url: z.string().default('http://127.0.0.1:11434') }),
]);
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export function loopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
export function trustedUrl(value: string, localOnly = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    (localOnly && !loopback(url)) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url)))) {
    throw new Error(localOnly ? '모델 URL은 루프백 주소여야 합니다.' : 'HTTPS 인스턴스 URL이 필요합니다.');
  }
  return url.href.replace(/\/$/, '');
}
export const NotificationProvider = z.enum(['mattermost', 'slack', 'discord', 'webhook']);
export type NotificationProvider = z.infer<typeof NotificationProvider>;
export const notificationEnv: Record<NotificationProvider, string> = {
  mattermost: 'MATTERMOST_WEBHOOK_URL', slack: 'SLACK_WEBHOOK_URL',
  discord: 'DISCORD_WEBHOOK_URL', webhook: 'HEYBOT_WEBHOOK_URL',
};
export const RepositorySchema = z.strictObject({
  platform: z.enum(['github', 'gitlab']),
  instance: z.string().transform(value => trustedUrl(value)),
  repository,
  botLogin: z.string().regex(/^[\w.\u0080-\uFFFF-]+$/).max(100),
  mode: z.enum(['publish', 'observe']),
  tokenEnv: envName,
  notifications: z.strictObject({
    provider: NotificationProvider,
    urlEnv: envName,
    channel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  }).optional(),
}).superRefine((repo, ctx) => {
  if (repo.platform === 'github' && repo.repository.split('/').length !== 2)
    ctx.addIssue({ code: 'custom', message: 'GitHub 저장소 경로는 owner/repo 형식이어야 합니다.' });
  if (repo.notifications?.channel && repo.notifications.provider !== 'mattermost')
    ctx.addIssue({ code: 'custom', message: '--notify-channel은 Mattermost에서 사용할 수 있습니다.' });
});
export type RepositoryConfig = z.infer<typeof RepositorySchema>;

const ConfigSchema = z.strictObject({
  version: z.literal(1),
  model: ModelConfigSchema.optional(),
  repositories: z.array(RepositorySchema),
});
export type Config = z.infer<typeof ConfigSchema>;
export const home = () => resolve(process.env.HEYBOT_HOME || join(homedir(), '.heybot_local'));
export const repositoryKey = (repo: Pick<RepositoryConfig, 'platform' | 'instance' | 'repository'>) =>
  JSON.stringify([repo.platform, repo.instance, repo.repository.toLowerCase()]);
export function repositoryWebBase(target: Pick<RepositoryConfig, 'platform' | 'instance'>): string {
  const url = new URL(target.instance);
  if (target.platform === 'github') {
    if (url.hostname === 'api.github.com') url.hostname = 'github.com';
    else if (url.hostname.startsWith('api.') && url.hostname.endsWith('.ghe.com')) url.hostname = url.hostname.slice(4);
    url.pathname = url.pathname.replace(/\/api\/v3\/?$/, '');
  }
  return url.href.replace(/\/$/, '');
}
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function readConfig(dir: string): Promise<Config> {
  try { return ConfigSchema.parse(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, repositories: [] };
  }
}
export async function writeConfig(dir: string, config: Config): Promise<void> {
  const path = join(dir, `config-${randomUUID()}.tmp`);
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(path, join(dir, 'config.json'));
}
export function credential(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`환경 변수 ${name}에 인증 정보가 필요합니다.`);
  return value;
}
