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

export async function pollGithub(platform: Platform, cursor: Cursor, now: number): Promise<Event[]> {
  const floor = recentFloor(cursor);
  const events: Event[] = [];
  for await (const pr of platform.api.items(`${platform.root}/pulls?state=all&sort=updated&direction=desc`)) {
    if (time(pr.updated_at) < floor) break;
    if (pr.state !== 'closed' || !positiveInteger(pr.number)) continue;
    const detail = pr.merged_at === undefined ? await platform.api.request(`${platform.root}/pulls/${pr.number}`) : pr;
    if (!inWindow(detail.merged_at, floor, now)) continue;
    const target = platform.target(pr.number);
    events.push({ kind: 'review', target, headSha: detail.head?.sha, merged: true, deliveryId: `merge:${detail.merged_at}` });
  }

  const pulls = new Map<number, boolean>();
  for (const surface of ['issue', 'review'] as const) {
    const prefix = surface === 'issue' ? 'issues' : 'pulls';
    const since = encodeURIComponent(new Date(Math.floor(floor / 1000) * 1000).toISOString());
    const path = `${platform.root}/${prefix}/comments?sort=updated&direction=asc&since=${since}`;
    for await (const raw of platform.api.items(path)) {
      if (!inWindow(raw.updated_at ?? raw.created_at, floor, now) || !(time(raw.created_at) > cursor.baseline)) continue;
      const number = Number(String(surface === 'review' ? raw.pull_request_url : raw.issue_url).match(/\/(?:pulls|issues)\/(\d+)$/)?.[1]);
      if (!positiveInteger(number) || raw.user?.type === 'Bot') continue;
      const event = commandEvent(platform, platform.target(number), {
        id: String(raw.id), author: String(raw.user?.login ?? ''), body: String(raw.body ?? '').slice(0, 90000),
        surface, parentId: raw.in_reply_to_id ? String(raw.in_reply_to_id) : null, discussionId: null,
      });
      if (!event) continue;
      if (surface === 'issue') {
        if (!pulls.has(number)) {
          try { await platform.api.request(`${platform.root}/pulls/${number}`); pulls.set(number, true); }
          catch (error) {
            if (!(error instanceof HttpError && error.status === 404)) throw error;
            pulls.set(number, false);
          }
        }
        if (!pulls.get(number)) continue;
      }
      events.push(event);
    }
  }
  return events;
}
export function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export async function poll(platform: Platform, store: Store, now = Date.now(), notifications?: Notifications): Promise<void> {
  const key = repositoryKey(platform.config);
  const cursor = store.cursor(key);
  if (!cursor) {
    await platform.api.request(platform.root);
    store.saveScan(key, { baseline: now, through: now }, []);
    return;
  }
  if (now < cursor.through) throw new Error('시계가 마지막 조회보다 이전입니다.');
  if (platform.config.platform === 'gitlab') return pollGitlab(platform, store, key, cursor, now, notifications);
  const events = await pollGithub(platform, cursor, now);
  store.saveScan(key, { ...cursor, through: now }, platform.config.mode === 'publish' ? events : []);
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
  const notices: { target: Target; source: string; payload: Notification }[] = [];
  const notifySince = notifications?.enabled(platform.config) ? notifications.startedAt(platform.config, now) : Infinity;
  for (const mr of all) {
    const target = platform.target(mr.iid);
    const title = redact(String(mr.title ?? '')).slice(0, 500);
    if (inWindow(mr.created_at, notifySince, now))
      notices.push({ target, source: 'opened', payload: { kind: 'opened', title } });
    if (mr.state === 'merged') {
      const detail = mr.merged_at === undefined && inWindow(mr.updated_at, floor, now)
        ? await platform.api.request(`${platform.root}/merge_requests/${mr.iid}`) : mr;
      if (inWindow(detail.merged_at, cursor.baseline, now)) {
        if (inWindow(detail.merged_at, notifySince, now)) notices.push({ target, source: `merged:${detail.merged_at}`, payload: { kind: 'merged', title } });
        events.push({ target, kind: 'review', merged: true, headSha: detail.diff_refs?.head_sha ?? detail.sha, deliveryId: `merge:${detail.merged_at}` });
      }
    }
    for (const raw of await gitlabNotes(platform, mr.iid)) {
      if (!inWindow(raw.created_at, cursor.baseline, now) || !humanGitlabNote(platform, raw)) continue;
      const body = String(raw.body ?? '').slice(0, 90000);
      const comment: Comment = { id: String(raw.id), author: raw.author.username, authorId: positiveInteger(raw.author.id) ? raw.author.id : undefined, body, surface: 'note', parentId: null, discussionId: raw.discussion ?? null };
      const event = commandEvent(platform, target, comment, Boolean(raw.threadedReply));
      if (event) events.push(event);
      if (inWindow(raw.created_at, notifySince, now)) {
        const preview = redact(body).trim().split(/[\r\n]/, 1)[0] ?? '';
        notices.push({ target, source: `comment:${raw.id}`, payload: { kind: 'commented', title,
          noteId: comment.id, author: redact(String(raw.author.name ?? raw.author.username)).slice(0, 200),
          preview: preview.slice(0, 200) + (preview.length > 200 ? '…' : '') } });
      }
    }
  }
  store.saveScan(key, { ...cursor, through: now, sweep: nextPage }, platform.config.mode === 'publish' ? events : [],
    () => notices.forEach(item => notifications?.enqueue(item.target, item.source, item.payload)));
}

export async function pollLifecycle(platform: Platform, store: Store, notifications: Notifications, now = Date.now()): Promise<void> {
  const key = notifications.scope(platform.config) + ':lifecycle';
  const start = store.cursor(key) ?? { baseline: notifications.startedAt(platform.config, now), through: now };
  const { all, nextPage } = await gitlabRequests(platform, start, now, true);
  const notices: { target: Target; source: string; payload: Notification }[] = [];
  for (const mr of all) {
    const target = platform.target(mr.iid);
    const title = redact(String(mr.title ?? '')).slice(0, 500);
    try {
      for await (const entry of platform.api.items(`${platform.root}/merge_requests/${mr.iid}/resource_state_events`)) {
        if (!positiveInteger(entry.id) || !inWindow(entry.created_at, start.baseline, now)) continue;
        const kind = ['opened', 'reopened'].includes(entry.state) ? 'reopened' : entry.state === 'closed' ? 'closed' : null;
        if (kind) notices.push({ target, source: `state:${entry.id}`, payload: { kind, title } });
      }
    } catch (error) {
      if (!(error instanceof HttpError && [404, 405, 501].includes(error.status))) throw error;
      const prior = store.mrState(target);
      const kind = prior === 'closed' && mr.state === 'opened' ? 'reopened'
        : prior === 'opened' && mr.state === 'closed' ? 'closed' : null;
      if (kind && inWindow(mr.updated_at, start.baseline, now))
        notices.push({ target, source: `observed:${kind}:${mr.updated_at}`, payload: { kind, title } });
    }
  }
  store.saveScan(key, { ...start, through: now, sweep: nextPage }, [], () => {
    for (const mr of all) store.rememberMrState(platform.target(mr.iid), mr.state);
    for (const item of notices) notifications.enqueue(item.target, item.source, item.payload);
  });
}

export async function pollPush(platform: Platform, store: Store, notifications: Notifications, now = Date.now()): Promise<void> {
  const key = notifications.scope(platform.config) + ':push';
  const start = store.cursor(key) ?? { baseline: notifications.startedAt(platform.config, now), through: now };
  const floor = recentFloor(start);
  const day = new Date(floor - 86400000).toISOString().slice(0, 10);
  const target = platform.target(0);
  const notices: { source: string; payload: Notification | null }[] = [];
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
  for await (const event of platform.api.items(`${platform.root}/events?action=pushed&sort=desc&after=${day}`)) {
    if (time(event.created_at) < floor) break;
    if (!positiveInteger(event.id) || !inWindow(event.created_at, floor, now)) continue;
    const push = event.push_data;
    if (push?.action === 'removed' || (push?.ref_type && push.ref_type !== 'branch')) continue;
    const source = `push:${event.id}`;
    const after = push?.commit_to;
    if (sha(after) && /^0+$/.test(after)) continue;
    const before = push?.action === 'created' && push?.commit_from == null ? '0'.repeat(40) : push?.commit_from;
    if (typeof push?.ref !== 'string' || !push.ref || push.ref.length > 250 || !sha(after) || !sha(before) ||
      !Number.isSafeInteger(push.commit_count) || push.commit_count < 0) {
      notices.push({ source, payload: null });
      continue;
    }
    notices.push({ source, payload: { kind: 'push', branch: push.ref, count: push.commit_count,
      before, after, author: redact(String(event.author?.name ?? event.author_username ?? '')).slice(0, 200) } });
  }
  store.saveScan(key, { ...start, through: now }, [], () => notices.forEach(item => notifications.enqueue(target, item.source, item.payload)));
}
