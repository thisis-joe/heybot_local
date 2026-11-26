import { repositoryKey } from './config.js';
import type { Target } from './contracts.js';
import { parseCommand } from './commands.js';
import { commentKey, type Comment, type Event } from './events.js';
import { HttpError } from './http-client.js';
import type { Platform } from './platform.js';
import type { Cursor, Store } from './store.js';
import type { Notifications, Notification } from './notifications.js';
import { redact } from './redact.js';

const overlap = 120000;
export function time(value: unknown): number { return typeof value === 'string' ? Date.parse(value) : NaN; }
export function inWindow(value: unknown, floor: number, now: number): boolean {
  const at = time(value);
  return at > floor && at <= now;
}
export function commandEvent(platform: Platform, target: Target, comment: Comment, allowBare = Boolean(comment.parentId || comment.discussionId)): Event | undefined {
  if (!/^\d+$/.test(comment.id) || !comment.author || !comment.body.trim() || platform.owned({ ...comment, url: '', parentId: comment.parentId ?? undefined, discussionId: comment.discussionId ?? undefined })) return;
  if (!parseCommand(comment.body) && !/^\s*\/(?:hey|reviewbot)\b/i.test(comment.body)
    && !comment.body.trimStart().toLowerCase().startsWith(`@${platform.config.botLogin.toLowerCase()} `)
    && !allowBare) return;
  return { kind: 'command', target, deliveryId: `comment:${commentKey(comment)}`, comment };
}
export function recentFloor(cursor: Cursor): number { return Math.max(cursor.baseline, cursor.through - overlap); }

type Notice = { target: Target; source: string; payload: Notification; at: number };
function commentNotice(target: Target, source: string, title: string, comment: Comment, at: number, author = comment.author): Notice {
  const preview = redact(comment.body).trim().split(/[\r\n]/, 1)[0] ?? '';
  return { target, source, at, payload: { kind: 'commented', title, noteId: comment.id, author: redact(author).slice(0, 200),
    ...(comment.surface !== 'note' ? { surface: comment.surface } : {}),
    preview: preview.slice(0, 200) + (preview.length > 200 ? '…' : '') } };
}

async function* githubPulls(platform: Platform, floor: number): AsyncGenerator<any> {
  for await (const pr of platform.api.items(`${platform.root}/pulls?state=all&sort=updated&direction=desc`)) {
    if (time(pr.updated_at) < floor) return;
    if (positiveInteger(pr.number)) yield pr;
  }
}

async function pollGithub(platform: Platform, store: Store, key: string, cursor: Cursor, now: number, notifications?: Notifications): Promise<void> {
  const floor = recentFloor(cursor);
  const notifySince = notifications?.enabled(platform.config) ? notifications.startedAt(platform.config, now) : Infinity;
  const commentSince = Math.max(notifySince, notifications?.startsAfter(platform.config, 'commented') ?? Infinity);
  const events: Event[] = [], notices: Notice[] = [];
  const pulls = new Map<number, any>();
  for await (const pr of githubPulls(platform, floor)) {
    const target = platform.target(pr.number);
    const detail = pr.state === 'closed' && pr.merged_at === undefined
      ? await platform.api.request(`${platform.root}/pulls/${pr.number}`) : pr;
    pulls.set(pr.number, detail);
    const title = redact(String(detail.title ?? '')).slice(0, 500);
    const author = detail.user?.login;
    if (inWindow(detail.created_at, notifySince, now))
      notices.push({ target, source: 'opened', at: time(detail.created_at), payload: { kind: 'opened', title, author } });
    if (detail.state !== 'closed' || !inWindow(detail.merged_at, floor, now)) continue;
    events.push({ kind: 'review', target, headSha: detail.head?.sha, merged: true, deliveryId: `merge:${detail.merged_at}` });
    if (inWindow(detail.merged_at, notifySince, now))
      notices.push({ target, source: `merged:${detail.merged_at}`, at: time(detail.merged_at), payload: { kind: 'merged', title, author } });
  }

  for (const surface of ['issue', 'review'] as const) {
    const prefix = surface === 'issue' ? 'issues' : 'pulls';
    const since = encodeURIComponent(new Date(Math.floor(floor / 1000) * 1000).toISOString());
    const path = `${platform.root}/${prefix}/comments?sort=updated&direction=asc&since=${since}`;
    for await (const raw of platform.api.items(path)) {
      if (!inWindow(raw.updated_at ?? raw.created_at, floor, now) || !(time(raw.created_at) > cursor.baseline)) continue;
      const number = Number(String(surface === 'review' ? raw.pull_request_url : raw.issue_url).match(/\/(?:pulls|issues)\/(\d+)$/)?.[1]);
      if (!positiveInteger(number) || !positiveInteger(raw.id) || !raw.user?.login || raw.user.type === 'Bot') continue;
      const target = platform.target(number);
      const comment: Comment = {
        id: String(raw.id), author: String(raw.user.login), body: String(raw.body ?? '').slice(0, 90000),
        surface, parentId: raw.in_reply_to_id ? String(raw.in_reply_to_id) : null, discussionId: null,
      };
      if (platform.owned({ ...comment, url: '', parentId: comment.parentId ?? undefined, discussionId: undefined })) continue;
      const event = commandEvent(platform, target, comment);
      const notice = inWindow(raw.created_at, commentSince, now);
      if (!event && !notice) continue;
      if ((surface === 'issue' || notice) && !pulls.has(number)) {
        try { pulls.set(number, await platform.api.request(`${platform.root}/pulls/${number}`)); }
        catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
          pulls.set(number, null);
        }
      }
      if ((surface === 'issue' || notice) && !pulls.get(number)) continue;
      if (event) events.push(event);
      if (notice) notices.push(commentNotice(target, `comment:${commentKey(comment)}`, redact(String(pulls.get(number).title ?? '')).slice(0, 500), comment, time(raw.created_at)));
    }
  }
  store.saveScan(key, { ...cursor, through: now }, platform.config.mode === 'publish' ? events : [],
    () => notices.forEach(item => notifications?.enqueue(item.target, item.source, item.payload, item.at)));
}
export function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export async function poll(platform: Platform, store: Store, now = Date.now(), notifications?: Notifications): Promise<void> {
  const key = repositoryKey(platform.config);
  if (notifications?.enabled(platform.config)) notifications.startedAt(platform.config, now);
  const cursor = store.cursor(key);
  if (!cursor) {
    await platform.api.request(platform.root);
    store.saveScan(key, { baseline: now, through: now }, []);
    return;
  }
  if (now < cursor.through) throw new Error('시계가 마지막 조회보다 이전입니다.');
  if (platform.config.platform === 'gitlab') return pollGitlab(platform, store, key, cursor, now, notifications);
  return pollGithub(platform, store, key, cursor, now, notifications);
}

const sweepSize = 10;
async function gitlabRequests(platform: Platform, cursor: Cursor, now: number, sweep: boolean) {
  const path = `${platform.root}/merge_requests?scope=all&state=all`;
  const from = encodeURIComponent(new Date(recentFloor(cursor)).toISOString());
  const to = encodeURIComponent(new Date(now).toISOString());
  const recent = await platform.api.pages(`${path}&order_by=updated_at&sort=asc&updated_after=${from}&updated_before=${to}`);
  const older = sweep ? await platform.api.page(`${path}&order_by=created_at&sort=asc`, cursor.sweep ?? 1, sweepSize) : [];
  const all = [...new Map([...recent, ...older].filter(row => positiveInteger(row.iid)).map(row => [row.iid, row])).values()];
  return { all, nextPage: older.length === sweepSize ? (cursor.sweep ?? 1) + 1 : 1 };
}

async function gitlabNotes(platform: Platform, number: number): Promise<any[]> {
  const path = `${platform.root}/merge_requests/${number}`;
  const notes = await platform.api.pages(`${path}/notes?order_by=created_at&sort=desc`);
  const byId = new Map(notes.map(note => [note.id, note]));
  for (const discussion of await platform.api.pages(`${path}/discussions`)) {
    for (const [index, note] of (discussion.notes ?? []).entries()) {
      // Preserve the thread for replies and commands on a discussion root. Only replies imply a bare answer.
      byId.set(note.id, { ...byId.get(note.id), ...note,
        discussion: !discussion.individual_note ? String(discussion.id) : null,
        threadedReply: !discussion.individual_note && index > 0 });
    }
  }
  return [...byId.values()].sort((a, b) => time(a.created_at) - time(b.created_at) || Number(a.id) - Number(b.id));
}
function humanGitlabNote(platform: Platform, raw: any): boolean {
  return positiveInteger(raw.id) && !raw.system && !raw.author?.bot && typeof raw.author?.username === 'string'
    && !platform.owned({ author: raw.author.username, body: String(raw.body ?? ''), id: String(raw.id), surface: 'note', url: '' });
}
async function pollGitlab(platform: Platform, store: Store, key: string, cursor: Cursor, now: number, notifications?: Notifications): Promise<void> {
  const { all, nextPage } = await gitlabRequests(platform, cursor, now, true);
  const floor = recentFloor(cursor);
  const events: Event[] = [];
  const notices: Notice[] = [];
  const notifySince = notifications?.enabled(platform.config) ? notifications.startedAt(platform.config, now) : Infinity;
  const commentSince = Math.max(notifySince, notifications?.startsAfter(platform.config, 'commented') ?? Infinity);
  for (const mr of all) {
    const target = platform.target(mr.iid);
    const title = redact(String(mr.title ?? '')).slice(0, 500);
    if (inWindow(mr.created_at, notifySince, now))
      notices.push({ target, source: 'opened', at: time(mr.created_at), payload: { kind: 'opened', title } });
    if (mr.state === 'merged') {
      const detail = mr.merged_at === undefined && inWindow(mr.updated_at, floor, now)
        ? await platform.api.request(`${platform.root}/merge_requests/${mr.iid}`) : mr;
      if (inWindow(detail.merged_at, cursor.baseline, now)) {
        if (inWindow(detail.merged_at, notifySince, now)) notices.push({ target, source: `merged:${detail.merged_at}`, at: time(detail.merged_at), payload: { kind: 'merged', title } });
        events.push({ target, kind: 'review', merged: true, headSha: detail.diff_refs?.head_sha ?? detail.sha, deliveryId: `merge:${detail.merged_at}` });
      }
    }
    for (const raw of await gitlabNotes(platform, mr.iid)) {
      if (!inWindow(raw.created_at, cursor.baseline, now) || !humanGitlabNote(platform, raw)) continue;
      const body = String(raw.body ?? '').slice(0, 90000);
      const comment: Comment = { id: String(raw.id), author: raw.author.username, authorId: positiveInteger(raw.author.id) ? raw.author.id : undefined, body, surface: 'note', parentId: null, discussionId: raw.discussion ?? null };
      const event = commandEvent(platform, target, comment, Boolean(raw.threadedReply));
      if (event) events.push(event);
      if (inWindow(raw.created_at, commentSince, now))
        notices.push(commentNotice(target, `comment:${raw.id}`, title, comment, time(raw.created_at), String(raw.author.name ?? raw.author.username)));
    }
  }
  store.saveScan(key, { ...cursor, through: now, sweep: nextPage }, platform.config.mode === 'publish' ? events : [],
    () => notices.forEach(item => notifications?.enqueue(item.target, item.source, item.payload, item.at)));
}

async function pollGithubLifecycle(platform: Platform, store: Store, notifications: Notifications, key: string, cursor: Cursor, now: number): Promise<void> {
  const floor = Math.max(recentFloor(cursor),
    Math.min(notifications.startsAfter(platform.config, 'reopened'), notifications.startsAfter(platform.config, 'closed')));
  const notices: Notice[] = [];
  for await (const pr of githubPulls(platform, floor)) {
    const timeline = await platform.api.pages(`${platform.root}/issues/${pr.number}/timeline`);
    const mergedTimes = new Set([time(pr.merged_at), ...timeline.filter(entry => entry.event === 'merged').map(entry => time(entry.created_at))]);
    const target = platform.target(pr.number), title = redact(String(pr.title ?? '')).slice(0, 500);
    for (const entry of timeline) {
      if (!positiveInteger(entry.id) || !inWindow(entry.created_at, floor, now)) continue;
      const kind = entry.event === 'reopened' ? 'reopened'
        : entry.event === 'closed' && !mergedTimes.has(time(entry.created_at)) ? 'closed' : null;
      if (kind) notices.push({ target, source: `state:${entry.id}`, at: time(entry.created_at), payload: { kind, title, author: pr.user?.login } });
    }
  }
  store.saveScan(key, { ...cursor, through: now }, [], () => {
    for (const item of notices) notifications.enqueue(item.target, item.source, item.payload, item.at);
  });
}

export async function pollLifecycle(platform: Platform, store: Store, notifications: Notifications, now = Date.now()): Promise<void> {
  if (notifications.startsAfter(platform.config, 'reopened') === Infinity &&
      notifications.startsAfter(platform.config, 'closed') === Infinity) return;
  const key = notifications.scope(platform.config) + ':lifecycle';
  const baseline = notifications.startedAt(platform.config, now);
  const start = store.cursor(key) ?? { baseline, through: baseline };
  if (platform.config.platform === 'github') return pollGithubLifecycle(platform, store, notifications, key, start, now);
  const { all, nextPage } = await gitlabRequests(platform, start, now, true);
  const notices: Notice[] = [];
  for (const mr of all) {
    const target = platform.target(mr.iid);
    const title = redact(String(mr.title ?? '')).slice(0, 500);
    try {
      for await (const entry of platform.api.items(`${platform.root}/merge_requests/${mr.iid}/resource_state_events`)) {
        if (!positiveInteger(entry.id) || !inWindow(entry.created_at, start.baseline, now)) continue;
        const kind = ['opened', 'reopened'].includes(entry.state) ? 'reopened' : entry.state === 'closed' ? 'closed' : null;
        if (kind) notices.push({ target, source: `state:${entry.id}`, at: time(entry.created_at), payload: { kind, title } });
      }
    } catch (error) {
      if (!(error instanceof HttpError && [404, 405, 501].includes(error.status))) throw error;
      const prior = store.mrState(target);
      if (!prior) continue;
      const kind = prior.state === 'closed' && mr.state === 'opened' ? 'reopened'
        : prior.state === 'opened' && mr.state === 'closed' ? 'closed' : null;
      // A state observed before re-enabling this event cannot date a fallback transition.
      if (kind && prior.observedAt >= notifications.startsAfter(platform.config, kind) && inWindow(mr.updated_at, start.baseline, now))
        notices.push({ target, source: `observed:${kind}:${mr.updated_at}`, at: time(mr.updated_at), payload: { kind, title } });
    }
  }
  store.saveScan(key, { ...start, through: now, sweep: nextPage }, [], () => {
    for (const mr of all) store.rememberMrState(platform.target(mr.iid), mr.state, now);
    for (const item of notices) notifications.enqueue(item.target, item.source, item.payload, item.at);
  });
}

const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
async function pollGithubPush(platform: Platform, store: Store, notifications: Notifications, key: string, cursor: Cursor, floor: number, now: number): Promise<void> {
  const target = platform.target(0);
  const notices: { source: string; payload: Notification | null; at: number }[] = [];
  for await (const activity of platform.api.cursorItems(`${platform.root}/activity?direction=desc`)) {
    const timestamp = activity.timestamp ?? activity.pushed_at;
    if (time(timestamp) < floor) break;
    if (!positiveInteger(activity.id) || !inWindow(timestamp, floor, now) ||
        !['push', 'force_push', 'branch_creation'].includes(activity.activity_type)) continue;
    const ref = String(activity.ref ?? ''), after = activity.after;
    if (!ref.startsWith('refs/heads/') || (isSha(after) && /^0+$/.test(after))) continue;
    const source = `push:${activity.id}`, branch = ref.slice('refs/heads/'.length);
    const before = activity.activity_type === 'branch_creation' ? '0'.repeat(40) : activity.before;
    const payload = branch && branch.length <= 250 && isSha(before) && isSha(after)
      ? { kind: 'push' as const, branch, before, after, author: redact(String(activity.actor?.login ?? activity.pusher?.login ?? '')).slice(0, 200) }
      : null;
    notices.push({ source, payload, at: time(timestamp) });
  }
  store.saveScan(key, { ...cursor, through: now }, [], () => notices.forEach(item => notifications.enqueue(target, item.source, item.payload, item.at)));
}

export async function pollPush(platform: Platform, store: Store, notifications: Notifications, now = Date.now()): Promise<void> {
  const selectedSince = Math.min(notifications.startsAfter(platform.config, 'push'), notifications.startsAfter(platform.config, 'branch-created'));
  if (selectedSince === Infinity) return;
  const key = notifications.scope(platform.config) + ':push';
  const baseline = notifications.startedAt(platform.config, now);
  const start = store.cursor(key) ?? { baseline, through: baseline };
  if (platform.config.platform === 'github') {
    const floor = Math.max(selectedSince, start.baseline, start.through - 15 * 60000);
    return pollGithubPush(platform, store, notifications, key, start, floor, now);
  }
  const floor = Math.max(selectedSince, recentFloor(start));
  const day = new Date(floor - 86400000).toISOString().slice(0, 10);
  const target = platform.target(0);
  const notices: { source: string; payload: Notification | null; at: number }[] = [];
  for await (const event of platform.api.items(`${platform.root}/events?action=pushed&sort=desc&after=${day}`)) {
    if (time(event.created_at) < floor) break;
    if (!positiveInteger(event.id) || !inWindow(event.created_at, floor, now)) continue;
    const push = event.push_data;
    if (push?.action === 'removed' || (push?.ref_type && push.ref_type !== 'branch')) continue;
    const source = `push:${event.id}`;
    const after = push?.commit_to;
    if (isSha(after) && /^0+$/.test(after)) continue;
    const before = push?.action === 'created' && push?.commit_from == null ? '0'.repeat(40) : push?.commit_from;
    if (typeof push?.ref !== 'string' || !push.ref || push.ref.length > 250 || !isSha(after) || !isSha(before) ||
      !Number.isSafeInteger(push.commit_count) || push.commit_count < 0) {
      notices.push({ source, payload: null, at: time(event.created_at) });
      continue;
    }
    notices.push({ source, at: time(event.created_at), payload: { kind: 'push', branch: push.ref, count: push.commit_count,
      before, after, author: redact(String(event.author?.name ?? event.author_username ?? '')).slice(0, 200) } });
  }
  store.saveScan(key, { ...start, through: now }, [], () => notices.forEach(item => notifications.enqueue(target, item.source, item.payload, item.at)));
}
