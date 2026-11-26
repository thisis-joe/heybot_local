import { repositoryKey } from './config.js';
import type { Target } from './contracts.js';
import { parseCommand } from './commands.js';
import { commentKey, type Comment, type Event } from './events.js';
import { HttpError } from './http-client.js';
import type { Platform } from './platform.js';
import type { Cursor, Store } from './store.js';

const overlap = 120000;
export function time(value: unknown): number { return typeof value === 'string' ? Date.parse(value) : NaN; }
export function inWindow(value: unknown, floor: number, now: number): boolean {
  const at = time(value);
  return at > floor && at <= now;
}
export function commandEvent(platform: Platform, target: Target, comment: Comment): Event | undefined {
  if (!/^\d+$/.test(comment.id) || !comment.author || !comment.body.trim() || platform.owned({ ...comment, url: '', parentId: comment.parentId ?? undefined, discussionId: comment.discussionId ?? undefined })) return;
  if (!parseCommand(comment.body) && !/^\s*\/(?:hey|reviewbot)\b/i.test(comment.body)
    && !comment.body.trimStart().toLowerCase().startsWith(`@${platform.config.botLogin.toLowerCase()} `)
    && !comment.parentId && !comment.discussionId) return;
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

export async function poll(platform: Platform, store: Store, now = Date.now()): Promise<void> {
  const key = repositoryKey(platform.config);
  const cursor = store.cursor(key);
  if (!cursor) {
    await platform.api.request(platform.root);
    store.saveScan(key, { baseline: now, through: now }, []);
    return;
  }
  if (now < cursor.through) throw new Error('시계가 마지막 조회보다 이전입니다.');
  if (platform.config.platform !== 'github') throw new Error('GitLab polling is not configured');
  const events = await pollGithub(platform, cursor, now);
  store.saveScan(key, { ...cursor, through: now }, platform.config.mode === 'publish' ? events : []);
}
