import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChangeQuestion, Report, Snapshot, Target, Verdict } from './contracts.js';
import { questionId, sameRevision } from './learning.js';
import type { Event } from './events.js';
import type { InlineInput } from './platform.js';
import type { DiffMetadata } from './review.js';

export function targetKey(t: Target): string {
  return createHash('sha256').update(JSON.stringify([t.platform, t.instance, t.repository.toLowerCase(), t.number])).digest('hex');
}
export interface CommandResult {
  snapshot: Snapshot;
  body: string;
  questions?: ChangeQuestion[];
  batchKind?: 'csinterview' | 'morecs';
  labels?: string[];
  questionThread?: Omit<InlineInput, 'body'>;
  revealThreadVersion?: 1;
  start?: number;
  answered?: string;
  grades?: { id: string; verdict: Verdict }[];
}
export interface Job {
  id: string;
  kind: Event['kind'];
  body: Event;
  state: string;
  owner: string;
  attempts: number;
  result: Report | null;
  diff: Record<string, DiffMetadata> | null;
  max_inline: number;
  command_result: CommandResult | null;
}
export interface Cursor { baseline: number; through: number; sweep?: number }

export function watcherLock(dir: string): () => void {
  const db = new DatabaseSync(join(dir, 'watch-lock.sqlite'));
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) throw new Error('이 프로필에서 이미 heybot_local이 실행 중입니다.');
    throw error;
  }
  return () => db.close();
}

export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    const path = join(dir, 'state.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, target_key TEXT NOT NULL,
        delivery TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
        result TEXT, diff TEXT, max_inline INTEGER NOT NULL DEFAULT 0, review_seconds INTEGER,
        command_result TEXT, error TEXT, synced INTEGER NOT NULL DEFAULT 0,
        UNIQUE(target_key, delivery)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        key TEXT PRIMARY KEY, repository TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_queue ON notifications(repository,state,due);
      CREATE TABLE IF NOT EXISTS api_limits (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mr_states (target TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,due,sequence);
      CREATE INDEX IF NOT EXISTS jobs_history ON jobs(target_key,sequence);
    `);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cursor(key: string): Cursor | undefined {
    const row = this.db.prepare('SELECT data FROM cursors WHERE key=?').get(key);
    return row && JSON.parse(String(row.data));
  }
  saveScan(key: string, cursor: Cursor, events: Event[], extra?: () => void): void {
    this.transaction(() => {
      for (const event of events) this.enqueue(event);
      extra?.();
      this.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(cursor));
    });
  }
  apiLimit(key: string): number {
    return Number(this.db.prepare('SELECT until FROM api_limits WHERE key=?').get(key)?.until ?? 0);
  }
  saveApiLimit(key: string, until: number): void {
    this.db.prepare('INSERT INTO api_limits VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until=max(until,excluded.until)').run(key, until);
  }
  mrState(target: Target): string | undefined {
    return this.db.prepare('SELECT state FROM mr_states WHERE target=?').get(targetKey(target))?.state as string | undefined;
  }
  rememberMrState(target: Target, state: string): void {
    this.db.prepare('INSERT INTO mr_states VALUES(?,?) ON CONFLICT(target) DO UPDATE SET state=excluded.state').run(targetKey(target), state);
  }
  enqueue(event: Event): void {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,target_key,delivery,kind,body,state) VALUES(?,?,?,?,?,\'queued\')')
      .run(randomUUID(), targetKey(event.target), event.deliveryId, event.kind, JSON.stringify(event));
  }
  /** The watcher holds the process lock before resetting interrupted work. */
  recoverClaims(): void {
    this.db.exec("UPDATE notifications SET state='uncertain',error='delivery_interrupted' WHERE state='sending'");
    this.db.exec(`UPDATE jobs SET state=CASE state WHEN 'publishing' THEN 'ready' ELSE 'queued' END,
      due=max(due,CASE WHEN state='publishing' OR kind='command' THEN unixepoch()*1000+60000 ELSE 0 END), owner=NULL
      WHERE state IN ('running','publishing')`);
  }
  claim(allowed: (target: Target) => boolean, now = Date.now()): Job | null {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','ready') AND due<=? ORDER BY CASE state WHEN 'ready' THEN 0 ELSE 1 END, sequence").iterate(now);
    let job: Job | undefined;
    for (const row of rows) {
      const candidate = decode(row);
      if (allowed(candidate.body.target)) { job = candidate; break; }
    }
    if (!job) return null;
    const owner = randomUUID(), state = job.state === 'ready' ? 'publishing' : 'running';
    this.db.prepare('UPDATE jobs SET state=?, owner=?, attempts=attempts+1 WHERE id=?').run(state, owner, job.id);
    return { ...job, owner, state, attempts: job.attempts + 1 };
  }
  assertLease(id: string, owner: string): void {
    if (!this.db.prepare('SELECT 1 FROM jobs WHERE id=? AND owner=?').get(id, owner)) throw new Error('Job ownership lost');
  }
  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? decode(row) : null;
  }
  getTarget(t: Target): { report: Report } | null {
    const row = this.db.prepare("SELECT result FROM jobs WHERE target_key=? AND result IS NOT NULL AND state!='superseded' ORDER BY sequence DESC LIMIT 1").get(targetKey(t));
    return row ? { report: JSON.parse(String(row.result)) } : null;
  }
  saveResult(job: Job, report: Report, diff: Record<string, DiffMetadata>, maxInline: number, seconds: number | null): void {
    this.assertLease(job.id, job.owner);
    this.db.prepare("UPDATE jobs SET result=?,diff=?,max_inline=?,review_seconds=?,state='ready',owner=NULL,attempts=0,due=0,error=NULL WHERE id=?")
      .run(JSON.stringify(report), JSON.stringify(diff), maxInline, seconds, job.id);
  }
  saveCommandResult(id: string, owner: string, result: CommandResult): void {
    this.assertLease(id, owner);
    if (!this.db.prepare('UPDATE jobs SET command_result=? WHERE id=? AND command_result IS NULL').run(JSON.stringify(result), id).changes)
      throw new Error('Command result is already immutable');
  }
  learningBatches(snap: Snapshot): CommandResult[] {
    return this.commands(snap).map(row => row.result).filter(result => result.questions?.length);
  }
  questionHistory(snap: Snapshot): ChangeQuestion[] {
    const rows = this.db.prepare("SELECT result FROM jobs WHERE target_key=? AND result IS NOT NULL AND state IN ('completed','ready','publishing') ORDER BY sequence").all(targetKey(snap));
    const previous = rows.map(row => JSON.parse(String(row.result)) as Report)
      .filter(report => sameRevision(snap, report.snapshot)).flatMap(report => report.questions);
    return [...new Map(previous.map(q => [questionId(snap, q), q])).values()];
  }
  private commands(snap: Snapshot): { state: string; result: CommandResult }[] {
    return this.db.prepare('SELECT state,command_result FROM jobs WHERE target_key=? AND command_result IS NOT NULL ORDER BY sequence')
      .all(targetKey(snap))
      .map(row => ({ state: String(row.state), result: JSON.parse(String(row.command_result)) as CommandResult }))
      .filter(row => row.state !== 'superseded' && sameRevision(snap, row.result.snapshot));
  }
  answerResults(snap: Snapshot): Map<string, Verdict | null> {
    const results = new Map<string, Verdict | null>();
    for (const { state, result } of this.commands(snap)) {
      if (state !== 'completed') continue;
      if (result.grades) for (const grade of result.grades) results.set(grade.id, grade.verdict);
      else if (result.answered && !results.has(result.answered)) results.set(result.answered, null);
    }
    return results;
  }
  answeredQuestions(snap: Snapshot): Set<string> { return new Set(this.answerResults(snap).keys()); }
  pendingGrades(repo: Pick<Target, 'platform' | 'instance' | 'repository'>): { id: string; report: Report | null }[] {
    const rows = this.db.prepare(`SELECT id,command_result FROM jobs WHERE state='completed' AND synced=0
      AND command_result IS NOT NULL AND (json_type(command_result,'$.grades') IS NOT NULL OR json_type(command_result,'$.answered') IS NOT NULL)
      AND json_extract(body,'$.target.platform')=? AND json_extract(body,'$.target.instance')=?
      AND lower(json_extract(body,'$.target.repository'))=lower(?) ORDER BY sequence`).all(repo.platform, repo.instance, repo.repository);
    return rows.map(row => {
      const { snapshot } = JSON.parse(String(row.command_result)) as CommandResult;
      const report = this.getTarget(snapshot)?.report;
      return { id: String(row.id), report: report && sameRevision(report.snapshot, snapshot) ? report : null };
    });
  }
  markSynced(id: string): void { this.db.prepare('UPDATE jobs SET synced=1 WHERE id=?').run(id); }
  reviewEstimate(mode: 'full' | 'incremental'): { minutes: number; measured: boolean } {
    const rows = this.db.prepare("SELECT review_seconds AS seconds FROM jobs WHERE review_seconds IS NOT NULL AND json_extract(result,'$.mode')=? ORDER BY sequence DESC LIMIT 20").all(mode);
    const times = rows.map(row => Number(row.seconds)).sort((a, b) => a - b);
    const middle = (times.length - 1) / 2;
    return times.length ? { minutes: Math.max(1, Math.ceil((times[Math.floor(middle)]! + times[Math.ceil(middle)]!) / 120)), measured: true } : { minutes: 2, measured: false };
  }
  complete(job: Job): void {
    this.assertLease(job.id, job.owner);
    const state = job.result?.state === 'failed' ? 'failed' : 'completed';
    this.db.prepare('UPDATE jobs SET state=?,owner=NULL WHERE id=?').run(state, job.id);
  }
  supersede(job: Job): void {
    this.db.prepare("UPDATE jobs SET state='superseded',owner=NULL WHERE id=? AND owner=?").run(job.id, job.owner);
  }
  fail(job: Job, detail: string, retryAt: number, rateLimited = false, terminal = false): void {
    const state = terminal || (!rateLimited && job.attempts >= 3) ? 'failed' : job.state === 'publishing' ? 'ready' : 'queued';
    this.db.prepare('UPDATE jobs SET state=?,owner=NULL,due=?,error=?,attempts=attempts-? WHERE id=? AND owner=?')
      .run(state, retryAt, detail, rateLimited ? 1 : 0, job.id, job.owner);
  }
  retry(id: string): boolean {
    return Boolean(this.db.prepare(`UPDATE jobs SET state=CASE WHEN result IS NOT NULL AND json_extract(result,'$.state')!='failed' THEN 'ready' ELSE 'queued' END,
      result=CASE WHEN json_extract(result,'$.state')='failed' THEN NULL ELSE result END, attempts=0,error=NULL
      WHERE id=? AND state='failed'`).run(id).changes);
  }
  status() {
    return {
      jobs: this.db.prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state').all(),
      failures: this.db.prepare("SELECT id,kind,coalesce(error,json_extract(result,'$.summary')) AS error FROM jobs WHERE state='failed' ORDER BY sequence DESC LIMIT 20").all(),
      notifications: this.db.prepare('SELECT state,error,count(*) AS count FROM notifications GROUP BY state,error').all(),
      apiLimits: this.db.prepare('SELECT key,until FROM api_limits WHERE until>? ORDER BY key').all(Date.now()),
      cursors: this.db.prepare('SELECT key,data FROM cursors ORDER BY key').all().map(row => ({ key: row.key, ...JSON.parse(String(row.data)) })),
    };
  }
}

function decode(row: Record<string, unknown>): Job {
  const parsed = { ...row, body: JSON.parse(String(row.body)) };
  return Object.assign(parsed, Object.fromEntries(['result', 'diff', 'command_result'].map(key => [key, row[key] == null ? null : JSON.parse(String(row[key]))]))) as unknown as Job;
}
