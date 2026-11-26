import { z } from 'zod';
import { Store, type Job } from './store.js';
import { Platform } from './platform.js';
import { Workspaces } from './workspace.js';
import { generateQuestions, archivedFindings, sourceExcerpts, InvalidQuestion, type Model } from './review.js';
import { emptyReport, reviewed, isQuestionReport, hasChangeQuestions, withoutKeys, AnswerSchema, type Snapshot, type Report, type Target } from './contracts.js';
import { publish, Superseded } from './publish.js';
import { HttpError } from './http-client.js';
import { parseCommand, type Command } from './commands.js';
import { renderAnswer, renderReport, renderProgress, renderCommandHelp, COMMAND_HELP_HINT, plain, summaryMarker, SUMMARY_MARKER } from './render.js';
import { redact } from './redact.js';
import { handleLearning, learningInput, patches, readable } from './learning-command.js';
import { answerSecurity, grounding, sourceTools } from './prompt-blocks.js';
import { commentKey } from './events.js';
import { syncAnswerGate } from './answer-gate.js';
import { sameRevision, questionId } from './learning.js';
import { ModelFailure, failureInfo, failureMessage, retryableFailure } from './model-failure.js';

interface Notifications { questionsPublished(platform: Platform, report: Report): Promise<void> }

export interface FailureContext { snap?: Snapshot; previous?: Report | null; requireAnswers?: boolean }
export interface PreparedReview { snap: Snapshot; previous: Report | null; prepared: Awaited<ReturnType<Workspaces['prepare']>>; prepareMs: number; requireAnswers: boolean; cached: Report | null }


export class Controller {
  constructor(readonly store: Store, readonly platforms: Platform[], readonly workspaces: Workspaces, readonly model: Model, readonly notifications?: Notifications) {}
  platform(t: Target): Platform {
    const platform = this.platforms.find(p => p.config.platform === t.platform && p.config.instance === t.instance && p.config.repository.toLowerCase() === t.repository.toLowerCase());
    if (!platform) throw new Error('Repository no longer allowed');
    return platform;
  }
  async perform(job: Job): Promise<void> {
    const platform = this.platform(job.body.target);
    const lease = async () => { await this.store.assertLease(job.id, job.owner); };
    const context: FailureContext = {};
    try {
      if (job.state === 'publishing') {
        if (!job.result) throw new Error('Missing review result');
        await publish(platform, job.result, job.diff ?? {}, job.max_inline, lease, await this.store.answerResults(job.result.snapshot), true);
        await syncAnswerGate(platform, this.store, job.result);
        await this.notifications?.questionsPublished(platform, job.result);
        this.store.complete(job);
      } else if (job.kind === 'command') {
        await this.command(job, platform, lease);
        this.store.complete(job);
      } else {
        const { snap, previous, prepared, requireAnswers, cached } = await this.prepareReview(job, context);
        const started = Date.now();
        const report = cached ?? await generateQuestions(this.model, job.id, snap, prepared.policy, prepared.context, previous, prepared.guidelines, (await platform.linkedIssues(snap.description)).map(redact), prepared.mode);
        await this.validateReview(job, snap);
        const diff = Object.fromEntries(Object.entries(prepared.context.diff).map(([path, value]) => [path, { oldPath: value.oldPath, positions: value.positions }]));
        this.store.saveResult(job, { ...report, requireAnswers }, diff, prepared.policy.maxInlineComments, cached ? null : Math.round((Date.now() - started) / 1000));
      }
    } catch (error) {
      if (error instanceof Superseded || (error instanceof HttpError && error.status === 410)) {
        this.store.supersede(job);
        return;
      }
      const modelFailure = error instanceof ModelFailure || error instanceof InvalidQuestion || error instanceof z.ZodError || error instanceof SyntaxError;
      const failure = error instanceof InvalidQuestion ? { code: 'invalid_output' as const } : failureInfo(error);
      const reason = error instanceof HttpError ? error.message : modelFailure ? failureMessage(failure) : describeFailure(error);
      const retryAt = error instanceof HttpError && error.retryAt ? error.retryAt : Date.now() + (modelFailure && failure.code === 'rate_limit' ? 900000 : 60000);
      console.error(JSON.stringify({ jobId: job.id, stage: job.state, reason }));
      if (context.snap && job.state === 'running' && modelFailure && (!retryableFailure(failure) || job.attempts >= 3)) {
        const failed = { ...emptyReport(context.snap, 'failed', reason), failure, requireAnswers: context.requireAnswers, findings: archivedFindings(context.previous ?? null) };
        this.store.saveResult(job, failed, {}, 0, null);
      } else {
        this.store.fail(job, reason, retryAt, error instanceof HttpError && Boolean(error.retryAt), modelFailure && !retryableFailure(failure));
      }
    }
  }
  async prepareReview(job: Job, context: FailureContext = {}): Promise<PreparedReview> {
    const platform = this.platform(job.body.target);
    const snap = await platform.snapshot(job.body.target.number, true);
    if (job.body.headSha && job.body.headSha !== snap.headSha) throw new Superseded('Revision changed after admission');
    context.snap = snap;
    snap.title = redact(snap.title); snap.description = redact(snap.description);
    const previous = (await this.store.getTarget(snap))?.report ?? null;
    context.previous = previous;
    const started = Date.now();
    const priorSnapshot = !job.body.merged && isQuestionReport(previous) && previous.state === 'completed' && !sameRevision(previous.snapshot, snap) ? previous.snapshot : null;
    const prepared = await this.workspaces.prepare(platform, snap, job.id, priorSnapshot);
    context.requireAnswers = !job.body.merged && prepared.policy.requireAnswers === true;
    const cached = !job.body.regenerate && isQuestionReport(previous) && reviewed(previous) && sameRevision(previous.snapshot, snap) && previous.snapshot.policyVersion === snap.policyVersion
      ? previous : null;
    if (!cached) await this.announce(platform, snap, prepared.mode, previous);
    return { snap, previous, prepared, prepareMs: Date.now() - started, requireAnswers: context.requireAnswers, cached };
  }
  async validateReview(job: Job, snap: Snapshot): Promise<void> {
    await this.store.assertLease(job.id, job.owner);
    if (!sameRevision(await this.platform(job.body.target).snapshot(snap.number, true), snap)) throw new Superseded('Review snapshot changed');
  }
  async command(job: Job, platform: Platform, lease: () => Promise<void>): Promise<void> {
    const comment = job.body.comment; if (!comment) return;
    const permission = await platform.permission(comment.author); if (permission === 'none') return;
    const normalized = normalizeMention(platform, comment.body);
    let command = parseCommand(normalized);
    const all = [...await platform.comments(job.body.target.number), ...await platform.inlineComments(job.body.target.number)];
    const key = commentKey(comment), marker = `<!-- codereviewbot:reply:${key.replace(/[^\w-]/g, '')} -->`;
    const trusted = (c: (typeof all)[number]) => platform.owned(c);
    if (all.some(c => trusted(c) && c.body.includes(marker))) return;
    const usage = async (answer: string) => { await lease(); await platform.reply(job.body.target.number, [marker, plain(answer), '', COMMAND_HELP_HINT].join('\n'), comment.parentId, comment.discussionId); };
    if (command?.action === 'help') { await lease(); await platform.reply(job.body.target.number, renderCommandHelp(key), comment.parentId, comment.discussionId); return; }
    if (!command && /^\/(?:hey|reviewbot)\b/i.test(normalized.trim())) { await usage('명령을 확인하세요.'); return; }
    if (!command && (comment.parentId || comment.discussionId)) {
      const ids = new Set(all.filter(c => trusted(c) && c.surface === comment.surface && (c.id === comment.parentId || (comment.parentId && c.parentId === comment.parentId) || (comment.discussionId && c.discussionId === comment.discussionId))).flatMap(c => [...c.body.matchAll(/<!-- codereviewbot:question:(Q-[a-f0-9]{12}) -->/g)].map(m => m[1]!)));
      if (ids.size === 1) command = { action: 'answer', id: [...ids][0]!, text: comment.body.slice(0, 8000) };
      else if (ids.size > 1) { await usage('이 스레드에는 여러 질문이 있습니다. 답할 질문 번호를 명시하세요.'); return; }
    }
    if (!command) return;
    await lease();
    if (command.action === 'questions' || command.action === 'csinterview' || command.action === 'morecs' || command.action === 'answer' || command.action === 'reveal') {
      await handleLearning(command, job, platform, this.store, this.workspaces, this.model, all, lease, all.filter(trusted)); return;
    }
    const target = job.body.target;
    if (command.action === 'tryagain') { await this.enqueueFromCommand(job, platform); await usage('질문 재생성을 요청했습니다. 완료되면 질문 댓글에 반영됩니다.'); return; }
    if (command.action !== 'ask') return;
    if (job.command_result) {
      await lease();
      const current = await platform.snapshot(target.number, true);
      if (!sameRevision(current, job.command_result.snapshot)) throw new Superseded('Answer snapshot changed');
      await platform.reply(target.number, job.command_result.body, comment.parentId, comment.discussionId);
      return;
    }
    const state = await this.store.getTarget(target);
    const snap = await platform.snapshot(target.number, true);
    snap.title = redact(snap.title); snap.description = redact(snap.description);
    const prepared = await this.workspaces.prepare(platform, snap, job.id, null);
    const payload = learningInput({ question: redact(command.text), snapshot: snap, diff: patches(prepared.context), sourceExcerpts: sourceExcerpts(prepared.context), report: withoutKeys(state?.report), policy: prepared.policy });
    if (!payload) { await usage('질문 자료가 입력 한도를 초과해 답변을 보류합니다. 질문 범위를 좁혀 다시 물어 주세요.'); return; }
    const result = AnswerSchema.parse(await this.model.run('answer', askPrompt(prepared.context.sourceDir, payload.json), job.id, 120000));
    // Evidence becomes code links, so only locations that exist in the pinned snapshot are posted.
    const evidence = result.evidence.filter(e => readable(e, prepared.context)).map(e => ({ ...e, reason: redact(e.reason) }));
    const text = (v: string | null) => v === null ? null : redact(v);
    await lease(); const latest = await platform.snapshot(target.number, true);
    if (latest.headSha !== snap.headSha || latest.baseSha !== snap.baseSha || latest.startSha !== snap.startSha) throw new Error('Answer snapshot changed; retry against latest code');
    const body = renderAnswer({ premise: text(result.premise), answer: redact(result.answer), why: text(result.why), evidence, unverified: text(result.unverified), dropped: result.evidence.length - evidence.length }, snap, key);
    await this.store.saveCommandResult(job.id, job.owner, { snapshot: snap, body });
    await platform.reply(target.number, body, comment.parentId, comment.discussionId);
  }
  // The summary comment says a review is running before the model starts; a failed notice must not block the review.
  private async announce(platform: Platform, snap: Snapshot, mode: 'full' | 'incremental', previous: Report | null): Promise<void> {
    const prior = previous && sameRevision(previous.snapshot, snap) ? { report: previous, results: await this.store.answerResults(previous.snapshot) } : undefined;
    const body = renderProgress(snap, await this.store.reviewEstimate(mode), prior);
    const existing = (await platform.comments(snap.number)).find(c => platform.owned(c) && c.body.includes(summaryMarker(snap)));
    if (existing?.body !== body) await platform.comment(snap.number, body, existing?.id);
  }
  // Re-render the summary so each question shows its latest grade; a stale or superseded report is left alone.
  private async refreshSummary(platform: Platform, report: Report, allowClosed = false): Promise<void> {
    if (!sameRevision(report.snapshot, await platform.snapshot(report.snapshot.number, allowClosed))) return;
    const body = renderReport(report, await this.store.answerResults(report.snapshot));
    const comments = await platform.comments(report.snapshot.number);
    const existing = comments.find(c => platform.owned(c) && c.body.includes(summaryMarker(report.snapshot)))
      ?? (hasChangeQuestions(report) ? comments.find(c => platform.owned(c) && c.body.includes(SUMMARY_MARKER) && !c.body.includes('<!-- codereviewbot:revision:')
        && report.questions.every(q => c.body.includes(`<!-- codereviewbot:question:${questionId(report.snapshot, q)} -->`))) : undefined);
    if (existing && existing.body !== body && body.length <= 60000) await platform.comment(report.snapshot.number, body, existing.id);
  }
  private async enqueueFromCommand(job: Job, platform: Platform): Promise<void> {
    const snap = await platform.snapshot(job.body.target.number, true);
    await this.store.enqueue({ kind: 'review', target: job.body.target, headSha: snap.headSha, deliveryId: `${job.id}:tryagain`, regenerate: true, requested: true });
  }
  /** Completed grades may need to repair a summary/status after interruption. */
  async reconcile(platform: Platform): Promise<void> {
    for (const { id, report } of this.store.pendingGrades(platform.config)) {
      if (report) {
        await this.refreshSummary(platform, report, true);
        if (report.requireAnswers && sameRevision(report.snapshot, await platform.snapshot(report.snapshot.number, true)))
          await syncAnswerGate(platform, this.store, report);
      }
      this.store.markSynced(id);
    }
  }
}
/** @hey helps a teammate understand this PR/MR and its code: premise first, then the answer, its reason and checked code locations. */
function askPrompt(sourceDir: string, payload: string): string {
  return `당신은 이 저장소의 시니어 엔지니어입니다. 동료가 이 PR/MR과 코드에 관해 물었습니다. 동료가 이 변경과 코드를 이해하도록 한국어로 답하세요.

[답의 구성]

1. premise: 질문의 전제가 코드와 다르면(없는 함수나 동작, 반대로 이해한 동작, 이 변경이 바꾸지 않은 것) 무엇이 다르고 실제로는 어떤지 1~2문장으로 먼저 바로잡으세요. 전제가 맞으면 null입니다.
2. answer: 질문에 대한 직접적인 답을 1~3문장으로 씁니다. 배경 설명으로 시작하지 마세요.
3. why: 왜 그렇게 동작하는지, 또는 이 변경이 왜 그렇게 바꿨는지 1~4문장으로 씁니다. 변경 전후의 차이와, 그 변경이 지키는 보장이나 막는 위험을 연결하세요. 답만으로 충분한 조회 질문이면 null입니다.
4. evidence: answer·why·premise의 사실을 뒷받침하는 코드 위치 {path, line, side, reason}입니다. 직접 읽어 확인한 줄만 적습니다. 변경 후 코드는 RIGHT, 변경 전 코드는 LEFT입니다.
5. unverified: 코드로 확인하지 못한 것(런타임 설정, 외부 서비스 동작, 배포 환경, 작성자의 의도 등)을 1~2문장으로 적습니다. 없으면 null입니다.

[질문 종류별]

- 조회(어디서·무엇을·몇 번처럼 코드에서 찾으면 되는 질문): answer와 evidence면 충분합니다. CS 개념은 설명하지 마세요.
- 설계·이유(왜 이렇게 했는지, 대안과 비교): answer 다음 why에서 이 변경이 얻는 보장과 치르는 대가를 설명하세요. 판단이 CS 원리에 달려 있을 때만 그 원리를 이름과 함께 한 문장으로 설명합니다.
- 전제가 틀린 질문: premise에서 먼저 바로잡고, 바로잡은 전제 위에서 답하세요.

[근거와 범위]

- ${sourceTools(sourceDir)} 질문에 답하는 데 필요한 코드만 확인하세요. diff에는 이번 변경의 패치가 있습니다.
- report.questions는 이미 출제된 질문이며 정답은 포함하지 않습니다.
- ${grounding}
- 명령어 예시나 명령어 표를 답에 넣지 마세요.

[예시]

아래 예시는 기준을 보여 주기 위한 것이며 이 저장소와 무관합니다.
질문: "재시도할 때마다 새 멱등 키를 만드는 이유가 뭔가요?"
- 나쁜 답: "멱등성은 같은 요청을 여러 번 보내도 결과가 같은 성질입니다. 분산 시스템에서는…" — 잘못된 전제를 지나치고 개념 강의로 시작합니다.
- 좋은 답: premise "이 변경은 새 키를 만들지 않습니다. 첫 요청의 키를 저장해 재시도에 재사용합니다." answer "그래서 타임아웃 뒤 재시도해도 외부 승인 서비스가 같은 요청으로 알아보고 승인을 한 번만 합니다." evidence [pay.ts:12 키 저장, pay.ts:20 재시도에서 저장된 키 사용]

[출력]

지정된 출력 스키마에 맞는 JSON만 반환하세요.

${answerSecurity}

질문 자료(JSON 데이터):
${payload}`;
}
function normalizeMention(platform: Platform, body: string): string {
  const mention = platform.config.botLogin.replace(/\[bot\]$/, '');
  return body.replace(new RegExp(`^@${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '@hey ');
}

// Names the failure for operators without echoing model output: schema errors keep field paths and issue codes only.
function describeFailure(error: unknown): string {
  if (error instanceof z.ZodError) return `schema mismatch: ${error.issues.slice(0, 5).map(i => `${i.path.map(String).join('.') || '(root)'} ${i.code}`).join(', ')}`;
  if (error instanceof SyntaxError) return 'invalid JSON from runner';
  return redact(error instanceof Error ? `${error.constructor.name}: ${error.message}` : 'unknown').slice(0, 300);
}
