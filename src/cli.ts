#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { ModelConfigSchema, RepositorySchema, credential, home, readConfig, repositoryKey, sameLogin, trustedUrl, writeConfig } from './config.js';
import { Store, watcherLock } from './store.js';
import { Workspaces } from './workspace.js';
import { Platform } from './platform.js';
import { checkCodexLogin, createModel } from './models.js';
import { Controller } from './controller.js';
import { poll } from './poll.js';
import { HttpError } from './http-client.js';
import { ModelFailure, failureMessage } from './model-failure.js';
import { maskSecret, redact } from './redact.js';

const usage = `heybot_local
  connect github|gitlab OWNER/REPO --publisher LOGIN [--observe] [--token-env NAME] [--instance URL]
      [--mattermost-env NAME] [--mattermost-channel NAME]
  model codex [--model ID]
  model claude --model ID [--key-env NAME]
  model ollama --model ID [--url URL]
  watch [--interval SECONDS] [--once]
  status
  retry JOB_ID
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return; }
  const dir = home();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = await readConfig(dir);
  if (command === 'connect') {
    const { values, positionals: [platform, repository, ...rest] } = parseArgs({ args, allowPositionals: true, options: {
      publisher: { type: 'string' }, observe: { type: 'boolean' }, 'token-env': { type: 'string' }, instance: { type: 'string' },
      'mattermost-env': { type: 'string' }, 'mattermost-channel': { type: 'string' },
    } });
    if (rest.length || !values.publisher) throw new Error('connect에 플랫폼, 저장소 경로, --publisher 계정을 지정하세요.');
    const repo = RepositorySchema.parse({ platform, repository, botLogin: values.publisher, mode: values.observe ? 'observe' : 'publish',
      tokenEnv: values['token-env'] ?? (platform === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'),
      instance: values.instance ?? (platform === 'github' ? 'https://api.github.com' : 'https://gitlab.com'),
      mattermostWebhookEnv: values['mattermost-env'], mattermostChannel: values['mattermost-channel'] });
    const client = new Platform(repo, async () => credential(repo.tokenEnv));
    await verifyAccount(client);
    await client.api.request(client.root);
    config.repositories = [...config.repositories.filter(r => repositoryKey(r) !== repositoryKey(repo)), repo];
    await writeConfig(dir, config);
    console.log(`${platform} ${repository} 연결됨 (${repo.mode})`);
    if (repo.mode === 'publish') console.log(`게시 담당 계정은 ${repo.botLogin}입니다. 팀에서 지정한 PC 한 대에서 게시 모드를 실행하세요.`);
    return;
  }
  if (command === 'model') {
    const { values, positionals: [provider, ...rest] } = parseArgs({ args, allowPositionals: true, options: {
      model: { type: 'string' }, 'key-env': { type: 'string' }, url: { type: 'string' },
    } });
    if (rest.length) throw new Error('모델 제공자를 하나 지정하세요.');
    config.model = ModelConfigSchema.parse({ provider, model: values.model,
      ...(values.url !== undefined ? { url: trustedUrl(values.url, true) } : {}), ...(values['key-env'] ? { keyEnv: values['key-env'] } : {}) });
    if (config.model.provider === 'codex') await checkCodexLogin();
    await writeConfig(dir, config);
    console.log(`모델 설정됨 (${config.model.provider}${config.model.model ? ` / ${config.model.model}` : ''})`);
    return;
  }
  const store = new Store(dir);
  try {
    if (command === 'status' && !args.length) {
      let watching = false;
      try { watcherLock(dir)(); }
      catch (error) {
        if (!(error instanceof Error && error.message.includes('이미'))) throw error;
        watching = true;
      }
      console.log(JSON.stringify({ watching, ...config, ...store.status() }, null, 2));
    } else if (command === 'retry' && args.length === 1) {
      if (!store.retry(args[0]!)) throw new Error('다시 실행할 실패 작업을 찾지 못했습니다.');
      console.log('작업을 대기열에 넣었습니다.');
    } else if (command === 'watch') {
      const { values } = parseArgs({ args, options: { interval: { type: 'string', default: '60' }, once: { type: 'boolean' } } });
      const seconds = Number(values.interval);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error('--interval은 5~3600초여야 합니다.');
      if (!config.repositories.length) throw new Error('먼저 connect로 저장소를 연결하세요.');
      if (!config.model && config.repositories.some(r => r.mode === 'publish')) throw new Error('먼저 model로 모델을 설정하세요.');
      const unlock = watcherLock(dir);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try {
        store.recoverClaims();
        for (const repo of config.repositories) {
          maskSecret(process.env[repo.tokenEnv]);
          if (repo.mattermostWebhookEnv) maskSecret(process.env[repo.mattermostWebhookEnv]);
        }
        if (config.model?.provider === 'claude') maskSecret(process.env[config.model.keyEnv]);
        const platforms = config.repositories.map(repo => new Platform(repo, async () => credential(repo.tokenEnv)));
        const workspaces = new Workspaces(dir);
        const controller = new Controller(store, platforms, workspaces, config.model ? createModel(config.model) : { run: async () => { throw new Error('모델이 없습니다.'); } });
        do {
          const active = new Set<string>();
          let failed = false;
          for (const platform of platforms) {
            if (abort.signal.aborted) break;
            try {
              await verifyAccount(platform);
              if (platform.config.mode === 'publish') active.add(repositoryKey(platform.config));
              await poll(platform, store);
            } catch (error) {
              failed = true;
              console.error(`${platform.config.repository} 조회 실패. ${message(error)}`);
            }
          }
          while (!abort.signal.aborted) {
            const job = store.claim(target => active.has(repositoryKey(target)));
            if (!job) break;
            await controller.perform(job);
          }
          for (const platform of platforms.filter(p => active.has(repositoryKey(p.config)))) {
            try { await controller.reconcile(platform); }
            catch (error) { failed = true; console.error(`${platform.config.repository} 채점 상태 갱신 실패. ${message(error)}`); }
          }
          await workspaces.cleanup();
          if (values.once) { if (failed) process.exitCode = 1; break; }
          if (!abort.signal.aborted) await sleep(seconds * 1000, undefined, { signal: abort.signal }).catch(() => {});
        } while (!abort.signal.aborted);
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        unlock();
      }
    } else throw new Error('명령과 옵션을 확인하세요. heybot_local --help');
  } finally { store.close(); }
}
async function verifyAccount(platform: Platform): Promise<void> {
  const account = await platform.identity();
  if (platform.config.mode === 'publish' && !sameLogin(account, platform.config.botLogin))
    throw new Error(`토큰 계정 ${account}이 지정된 게시 계정 ${platform.config.botLogin}과 다릅니다.`);
}
function message(error: unknown): string {
  if (error instanceof ModelFailure) return failureMessage(error.failure);
  if (error instanceof HttpError) return error.message + (error.retryAt ? ` 다음 API 호출: ${new Date(error.retryAt).toISOString()}` : '');
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || '설정'}: ${issue.message}`).join('\n');
  return error instanceof Error ? redact(error.message) : '알 수 없는 오류';
}
main().catch(error => { console.error(message(error)); process.exitCode = 1; });
