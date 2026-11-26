import { credential, loopback, repositoryKey, repositoryWebBase, trustedUrl, NotificationEvent, type NotificationProvider, type RepositoryConfig } from './config.js';
import { createHash } from 'node:crypto';
import type { Target, Report } from './contracts.js';
import { hasChangeQuestions } from './contracts.js';
import type { Platform } from './platform.js';
import { type Store, targetKey } from './store.js';
import { plain, summaryMarker } from './render.js';
import { HttpError } from './http-client.js';
import { redact } from './redact.js';

type PushCommit = { id: string; subject: string; timestamp: number | null; parentCount?: number };
export type Notification = { kind: 'opened' | 'reopened' | 'merged' | 'closed'; title: string; author?: string }
  | { kind: 'questions'; title: string; count: number; noteId: string; partial?: boolean }
  | { kind: 'commented'; title: string; noteId: string; surface?: 'issue' | 'review'; author?: string; preview?: string }
  | { kind: 'push'; branch: string; count?: number; author: string; before: string; after: string; commits?: PushCommit[] };
// Store subjects, ordering and parent counts; never trust webhook-provided URLs.
function pushCommits(values: unknown): PushCommit[] {
  if (!Array.isArray(values)) return [];
  return [...new Map(values.flatMap(c => {
    if (!c || typeof c.id !== 'string' || !/^[a-f0-9]{40,64}$/.test(c.id)) return [];
    const message = typeof c.message === 'string' ? c.message : typeof c.title === 'string' ? c.title : '';
    const subject = redact(message).trim().split(/[\r\n]/, 1)[0]!.trim().slice(0, 500);
    if (!subject) return [];
    const timestamp = Date.parse(c.timestamp ?? c.committed_date ?? c.created_at);
    const parents = Array.isArray(c.parent_ids) && c.parent_ids.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{40,64}$/.test(id)) ? c.parent_ids : undefined;
    return [[c.id, { id: c.id, subject, timestamp: Number.isFinite(timestamp) ? timestamp : null, ...(parents ? { parentCount: parents.length } : {}) }] as const];
  })).values()];
}

export function givenName(display: string): string {
  const name = display.split(/[\[(_]/, 1)[0]!.trim();
  if (!name) return '작성자';
  const parts = name.split(/\s+/), first = parts[0]!;
  if (/^[가-힣]$/.test(first) && parts[1]) return parts[1];
  if (/^[가-힣]{2,4}$/.test(first)) return first.slice(/^(남궁|황보|제갈|선우|독고|서문|사공|동방)/.test(first) ? 2 : 1);
  return first;
}

export function renderNotification(target: Target, notification: Notification, author: string): string {
  const github = target.platform === 'github';
  const project = `${repositoryWebBase(target)}/${target.repository.split('/').map(encodeURIComponent).join('/')}`;
  const type = github ? 'PR' : 'MR';
  if (notification.kind === 'push') {
    const who = plain(givenName(notification.author)), branch = plain(redact(notification.branch));
    const created = /^0+$/.test(notification.before);
    const history = github ? project : `${project}/-`;
    const branchPath = encodeURIComponent(notification.branch).replace(/[()]/g, c => c === '(' ? '%28' : '%29');
    const link = created ? `${history}/commits/${branchPath}` : `${history}/compare/${notification.before}...${notification.after}`;
    const commits = notification.commits ?? [];
    const classified = notification.count !== undefined && commits.length === notification.count && commits.every(c => c.parentCount !== undefined);
    const merges = commits.filter(c => c.parentCount !== undefined && c.parentCount > 1).length;
    const counts = classified ? `신규/변경 커밋 ${(notification.count ?? 0) - merges}개` : '신규/변경 커밋 수 확인 필요';
    const headline = created ? `**${who}**님의 **새 브랜치가 생겼어요.** 🌱` : `**${who}**님의 **${counts}**가 올라왔어요. 🚀`;
    const lines = created ? [] : [...commits].filter(c => c.parentCount !== undefined && c.parentCount <= 1)
      .sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity))
      .map(c => {
        const match = /^([a-zA-Z]+(?:\([^\r\n]*?\))?!?:)\s+(.+)$/.exec(c.subject);
        const label = match ? `*${plain(match[1]!)}* **${plain(match[2]!)}**` : `**${plain(c.subject)}**`;
        return `- [${label}](${history}/commit/${c.id})`;
      });
    return `${headline}\n[**${branch}**](${link})${lines.length ? '\n\n' + lines.join('\n') : ''}`;
  }
  const url = github ? `${project}/pull/${target.number}` : `${project}/-/merge_requests/${target.number}`;
  const anchor = !github ? 'note_' : notification.kind === 'commented' && notification.surface === 'review' ? 'discussion_r' : 'issuecomment-';
  const link = 'noteId' in notification ? `${url}#${anchor}${notification.noteId}` : url;
  const who = plain(givenName(('author' in notification ? notification.author : undefined) ?? author));
  const labels = {
    questions: `**${who}**님의 ${type}에 **질문이 준비됐어요.** 🧩`,
    opened: `**${who}**님이 **새 ${type}**을 열었어요. 📬`,
    reopened: `**${who}**님이 **${type}을 다시 열었어요.** 🔄`,
    merged: `**${who}**님의 **${type}이 머지됐어요!** 🎉`,
    closed: `**${who}**님의 **${type}이 닫혔어요.** 🗃️`,
    commented: `**${who}**님이 ${type}에 **댓글을 남겼어요.** 💬`,
  };
  const preview = notification.kind === 'commented' && notification.preview ? `\n\n*“${plain(redact(notification.preview))}”*` : '';
  return `${labels[notification.kind]}\n[**${type} ${github ? '#' : '!'}${target.number} · ${plain(redact(notification.title).slice(0, 500))}**](${link})${preview}`;
}


type EventStarts = Partial<Record<NotificationEvent, number>>;

function eventKind(payload: Notification): NotificationEvent {
  return payload.kind === 'push' && /^0+$/.test(payload.before) ? 'branch-created' : payload.kind;
}

function withoutPreview(payload: Notification): Notification {
  if (payload.kind !== 'commented') return payload;
  const { preview, ...comment } = payload;
  return comment;
}

/** The watcher lock serializes applying controls with scanning and delivery. */
export function applyNotificationControls(store: Store, repo: RepositoryConfig, now = Date.now()): EventStarts {
  const config = repo.notifications;
  if (!config) return {};
  const key = repositoryKey(repo);
  return store.transaction(() => {
    const row = store.db.prepare('SELECT starts FROM notification_filters WHERE repository=?').get(key);
    const previous: EventStarts | undefined = row && JSON.parse(String(row.starts));
    const starts: EventStarts = {};
    for (const kind of config.events ?? NotificationEvent.options) {
      // Keep the cutoff of events that stay enabled. Only newly enabled events start at this change.
      starts[kind] = previous ? previous[kind] ?? now : 0;
    }
    const data = JSON.stringify(starts);
    if (data !== row?.starts) {
      store.db.prepare('INSERT INTO notification_filters VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET starts=excluded.starts')
        .run(key, data);
    }
    if (config.events || config.commentPreview === false) {
      // Include paused destinations for the same repository. Destination scopes start with the key followed by ':'.
      const queued = store.db.prepare("SELECT key,payload FROM notifications WHERE repository>=? AND repository<? AND state='queued'")
        .all(key + ':', key + ';');
      const removePreview = store.db.prepare("UPDATE notifications SET payload=json_remove(payload,'$.preview') WHERE key=?");
      const skip = store.db.prepare("UPDATE notifications SET state='skipped',error='event_filtered' WHERE key=?");
      for (const row of queued) {
        const id = String(row.key);
        const payload = JSON.parse(String(row.payload)) as Notification;
        if (config.commentPreview === false && payload.kind === 'commented' && payload.preview !== undefined)
          removePreview.run(id);
        if (starts[eventKind(payload)] === undefined) skip.run(id);
      }
    }
    return starts;
  });
}

/** Destinations come from the local configuration. Save intent before attempting the HTTP write. */
export class Notifications {
  private readonly destinations = new Map<string, Platform>();
  private readonly eventStarts = new Map<string, EventStarts>();
  constructor(readonly store: Store, platforms: Platform[], readonly transport: typeof fetch = fetch) {
    for (const platform of platforms) {
      const config = platform.config;
      if (config.mode === 'publish' && config.notifications) {
        const key = repositoryKey(config);
        this.destinations.set(key, platform);
        this.eventStarts.set(key, applyNotificationControls(store, config));
      }
    }
  }
  enabled(target: Pick<Target, 'platform' | 'instance' | 'repository'>): boolean {
    return this.destinations.has(repositoryKey(target));
  }
  startsAfter(target: Pick<Target, 'platform' | 'instance' | 'repository'>, kind: NotificationEvent): number {
    return this.eventStarts.get(repositoryKey(target))?.[kind] ?? Infinity;
  }
  scope(target: Pick<Target, 'platform' | 'instance' | 'repository'>): string {
    const key = repositoryKey(target);
    const config = this.destinations.get(key)?.config.notifications;
    if (!config) throw new Error('Notification destination unavailable');
    // Preserve the original scope, including its JSON field order, for existing cursors and delivery IDs.
    const { provider, urlEnv, channel } = config;
    return `${key}:${JSON.stringify({ provider, urlEnv, channel })}`;
  }
  startedAt(target: Pick<Target, 'platform' | 'instance' | 'repository'>, now: number): number {
    const key = this.scope(target) + ':notifications';
    const cursor = this.store.cursor(key);
    if (cursor) return cursor.baseline;
    this.store.saveScan(key, { baseline: now, through: now }, []);
    return now;
  }
  enqueue(target: Target, source: string, payload: Notification | null, at: number): void {
    const cutoff = payload ? this.startsAfter(target, eventKind(payload))
      : Math.min(this.startsAfter(target, 'push'), this.startsAfter(target, 'branch-created'));
    if (!(at > cutoff)) return;
    const config = this.destinations.get(repositoryKey(target))!.config.notifications!;
    if (payload && config.commentPreview === false) payload = withoutPreview(payload);
    const scope = this.scope(target);
    const key = createHash('sha256').update(`${scope}:${targetKey(target)}:${source}`).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO notifications(key,repository,target,payload,state,error) VALUES(?,?,?,?,?,?)')
      .run(key, scope, JSON.stringify(target), JSON.stringify(payload), payload ? 'queued' : 'skipped', payload ? null : 'incomplete_push_event');
  }
  async questionsPublished(platform: Platform, report: Report): Promise<void> {
    const at = Date.now();
    if (at <= this.startsAfter(platform.config, 'questions') || !hasChangeQuestions(report)) return;
    const marker = summaryMarker(report.snapshot);
    const comment = (await platform.comments(report.snapshot.number)).find(c => platform.owned(c) && c.body.includes(marker));
    if (!comment || !/^\d+$/.test(comment.id)) throw new Error('Published question comment unavailable');
    this.enqueue(report.snapshot, `questions:${marker}`, { kind: 'questions', title: report.snapshot.title, count: report.questions.length, noteId: comment.id }, at);
  }
  async drain(active: Set<string>, signal: AbortSignal): Promise<void> {
    for (const repository of active) {
      if (signal.aborted) return;
      const destination = this.destinations.get(repository);
      if (!destination) continue;
      const rows = this.store.db.prepare("SELECT key,target,payload,attempts FROM notifications WHERE repository=? AND state='queued' AND due<=? ORDER BY rowid LIMIT 50").all(this.scope(destination.config), Date.now());
      for (const row of rows) {
        if (signal.aborted) return;
        const target = JSON.parse(String(row.target)) as Target;
        const payload = JSON.parse(String(row.payload)) as Notification;
        await this.deliver(String(row.key), target, payload, Number(row.attempts) + 1, destination);
      }
    }
  }
  private async deliver(key: string, target: Target, notification: Notification, attempt: number, platform: Platform): Promise<void> {
    const settle = (state: string, error: string | null, due = 0) => {
      this.store.db.prepare('UPDATE notifications SET state=?,error=?,due=?,attempts=? WHERE key=?').run(state, error, due, attempt, key);
    };
    const config = platform.config.notifications!;
    let url: string;
    try { url = webhookUrl(config.provider, credential(config.urlEnv)); }
    catch {
      this.store.db.prepare("UPDATE notifications SET error='destination_unavailable',due=? WHERE key=?").run(Date.now() + 60000, key);
      return;
    }
    let author = '', rangeUnavailable = false;
    try {
      if (notification.kind === 'push' && !/^0+$/.test(notification.before)) {
        if (target.platform === 'github') {
          try {
            const commits = await githubPushCommits(platform, notification.before, notification.after);
            notification.commits = commits;
            notification.count = commits.length;
          } catch (error) {
            // A force push can leave one of the old objects unreachable. Keep the branch and link.
            if (!(error instanceof UnavailableRange) && !(error instanceof HttpError && [404, 409, 422].includes(error.status))) throw error;
            rangeUnavailable = true;
          }
        } else {
          notification.commits = await gitlabPushCommits(platform, notification);
        }
      } else if (notification.kind !== 'push' && !('author' in notification && notification.author)) {
        const github = target.platform === 'github';
        const change = await platform.api.request(`${platform.root}/${github ? 'pulls' : 'merge_requests'}/${target.number}`);
        author = redact(String(github ? change.user?.login ?? '' : change.author?.name ?? ''));
      }
    } catch (error) {
      if (error instanceof HttpError && error.retryAt)
        this.store.db.prepare("UPDATE notifications SET error='source_rate_limited',due=? WHERE key=?").run(error.retryAt, key);
      else settle(attempt < 3 ? 'queued' : 'failed', 'source_lookup_failed', Date.now() + 60000);
      return;
    }
    const payload = webhookBody(config.provider, target, config.commentPreview === false ? withoutPreview(notification) : notification,
      author, key, config.channel);
    settle('sending', null);
    try {
      const response = await this.transport(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (response.ok) settle('sent', rangeUnavailable ? 'range_unavailable' : null);
      else if (response.status === 429 && attempt < 3) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const delay = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(retryAfter ?? '') - Date.now()) || 30000;
        settle('queued', 'rate_limited', Date.now() + Math.max(1000, delay));
      } else settle(response.status >= 500 ? 'uncertain' : 'failed', `http_${response.status}`);
    } catch {
      settle('uncertain', 'delivery_unknown');
    }
  }
}


type PushNotification = Extract<Notification, { kind: 'push' }>;
class UnavailableRange extends Error {}
async function githubPushCommits(platform: Platform, before: string, after: string): Promise<PushCommit[]> {
  const result: PushCommit[] = [];
  for (let page = 1; page <= 30; page++) {
    const compare = await platform.api.request(`${platform.root}/compare/${before}...${after}?per_page=100&page=${page}`);
    if (!Number.isSafeInteger(compare.total_commits) || compare.total_commits < 0 || compare.total_commits > 3000 || !Array.isArray(compare.commits))
      throw new UnavailableRange('Incomplete GitHub compare');
    result.push(...pushCommits(compare.commits.map((commit: any) => ({ id: commit.sha, message: commit.commit?.message,
      committed_date: commit.commit?.committer?.date, parent_ids: commit.parents?.map((parent: { sha: string }) => parent.sha) }))));
    if (compare.commits.length < 100 || result.length >= compare.total_commits) {
      if (result.length !== compare.total_commits || new Set(result.map(commit => commit.id)).size !== result.length ||
          result.some(commit => commit.parentCount === undefined)) throw new UnavailableRange('Incomplete GitHub compare');
      return result;
    }
  }
  throw new UnavailableRange('GitHub compare pagination limit');
}

async function gitlabPushCommits(platform: Platform, notification: PushNotification): Promise<PushCommit[]> {
  const compare = await platform.api.request(`${platform.root}/repository/compare?from=${notification.before}&to=${notification.after}&straight=true`);
  const commits = pushCommits(compare?.commits);
  if (compare?.compare_timeout || compare?.overflow || commits.length !== notification.count) throw new Error('Incomplete push range');
  for (const commit of commits) {
    if (commit.parentCount !== undefined) continue;
    const detail = await platform.api.request(`${platform.root}/repository/commits/${commit.id}`);
    const resolved = pushCommits([detail])[0];
    if (resolved?.id !== commit.id || resolved.parentCount === undefined) throw new Error('Missing commit parents');
    commit.parentCount = resolved.parentCount;
  }
  return commits;
}

export function webhookUrl(provider: NotificationProvider, value: string): string {
  const url = new URL(trustedUrl(value));
  if (loopback(url)) return url.href;
  const valid = provider === 'webhook'
    || (provider === 'mattermost' && /\/hooks\/[a-z0-9]+$/i.test(url.pathname))
    || (provider === 'slack' && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) && /^\/services\/[\w/-]+$/.test(url.pathname))
    || (provider === 'discord' && ['discord.com', 'discordapp.com'].includes(url.hostname) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname));
  if (!valid) throw new Error('선택한 서비스의 Incoming Webhook URL 형식을 확인하세요.');
  return url.href;
}

function fitLines(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  let used = 0;
  const keep = [];
  for (const line of lines) {
    if (used + line.length + 1 > limit - 80) break;
    keep.push(line);
    used += line.length + 1;
  }
  return [...keep, '… 나머지는 저장소 링크에서 확인할 수 있습니다.'].join('\n');
}

export function webhookBody(provider: NotificationProvider, target: Target, notification: Notification, author: string, id: string, channel?: string) {
  const text = renderNotification(target, notification, author);
  if (provider === 'mattermost') return { text, username: 'hey', ...(channel ? { channel } : {}) };
  if (provider === 'discord') return { username: 'hey', embeds: [{ description: fitLines(text, 4096) }], allowed_mentions: { parse: [] } };
  if (provider === 'slack') {
    const safe = fitLines(text, 35000).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/\[([^\n]+?)\]\((https?:[^\s)]+)\)/g, (_, label: string, url: string) => `<${url}|${label.replaceAll('|', '¦')}>`);
    return { text: safe, link_names: 0, unfurl_links: false, unfurl_media: false };
  }
  return { version: 1, id, event: notification.kind, repository: { platform: target.platform, instance: target.instance, path: target.repository },
    ...(target.number ? (target.platform === 'github' ? { pullRequest: target.number } : { mergeRequest: target.number }) : {}), text };
}
