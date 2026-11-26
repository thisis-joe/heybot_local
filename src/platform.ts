import { ApiClient, HttpError, type TokenSource } from './http-client.js';
import { loopback, sameLogin, type RepositoryConfig } from './config.js';
import { Sha, type Snapshot, type Target, type Candidate } from './contracts.js';
import type { DiffPosition } from './review.js';
import { hasOutputMarker } from './events.js';
import { GATE_CONTEXT, type GateStatus } from './answer-gate.js';

export interface RemoteComment { id: string; body: string; author: string; url: string; discussionId?: string; parentId?: string; surface: 'issue' | 'review' | 'note' }
export interface InlineInput { path: string; oldPath: string; line: number; side?: 'LEFT' | 'RIGHT'; coordinates?: DiffPosition; body: string; suggestion: Candidate['suggestion'] }
export class Platform {
  readonly api: ApiClient;
  readonly root: string;
  constructor(readonly config: RepositoryConfig, readonly token: TokenSource, limitedUntil = 0, onLimit?: (retryAt: number) => void) {
    this.api = new ApiClient(config.platform === 'github' ? config.instance : `${config.instance}/api/v4`, config.platform, token, limitedUntil, onLimit);
    this.root = config.platform === 'github' ? `/repos/${config.repository.split('/').map(encodeURIComponent).join('/')}` : `/projects/${encodeURIComponent(config.repository)}`;
  }
  target(number: number): Target { return { platform: this.config.platform, instance: this.config.instance, repository: this.config.repository, number }; }
  async snapshot(number: number, allowClosed = false): Promise<Snapshot> {
    const gh = this.config.platform === 'github';
    const pr = await this.api.request(`${this.root}/${gh ? 'pulls' : 'merge_requests'}/${number}`);
    if (!allowClosed && ((gh && (pr.state !== 'open' || pr.merged)) || (!gh && pr.state !== 'opened'))) throw new HttpError(410, 'PR/MR is closed');
    const merged = gh ? pr.merged === true : pr.state === 'merged';
    let baseSha: string, headSha: string, startSha: string, policySha: string | undefined;
    if (gh) {
      headSha = Sha.parse(pr.head?.sha); startSha = Sha.parse(pr.base?.sha);
      let parentCount = 0;
      if (merged) {
        const commit = await this.api.request(`${this.root}/commits/${Sha.parse(pr.merge_commit_sha)}`);
        startSha = Sha.parse(commit.parents?.[0]?.sha);
        parentCount = commit.parents.length;
      }
      const comparison = await this.api.request(`${this.root}/compare/${startSha}...${headSha}`);
      baseSha = Sha.parse(comparison.merge_base_commit?.sha);
      // GitHub reports the last rewritten commit for rebase merges. Its parent may come
      // from the PR, so use the trusted common ancestor when squash/rebase is ambiguous.
      if (merged && parentCount === 1 && pr.commits !== 1) policySha = baseSha;
    } else {
      baseSha = Sha.parse(pr.diff_refs?.base_sha); headSha = Sha.parse(pr.diff_refs?.head_sha); startSha = Sha.parse(pr.diff_refs?.start_sha);
    }
    const webUrl = String(gh ? pr.html_url : pr.web_url);
    const web = new URL(webUrl), allowed = new URL(this.config.instance);
    const expectedHost = allowed.hostname === 'api.github.com' ? 'github.com' : allowed.hostname;
    if ((web.protocol !== 'https:' && !(loopback(allowed) && web.origin === allowed.origin)) || web.hostname !== expectedHost || web.username || web.password) throw new Error('Unexpected PR/MR web URL');
    return { ...this.target(number), baseSha, headSha, startSha, ...(policySha ? { policySha } : {}), merged, policyVersion: 'default', title: String(pr.title ?? '').slice(0, 500), description: String((gh ? pr.body : pr.description) ?? '').slice(0, 20000), webUrl };
  }
  async comments(number: number): Promise<RemoteComment[]> {
    const gh = this.config.platform === 'github';
    const values = await this.api.pages(`${this.root}/${gh ? 'issues' : 'merge_requests'}/${number}/${gh ? 'comments' : 'notes'}`);
    return values.map(c => ({ id: String(c.id), body: String(c.body ?? ''), author: String(gh ? c.user?.login : c.author?.username), url: c.html_url ?? (gh ? '' : this.noteUrl(number, c.id)), discussionId: c.discussion_id, surface: gh ? 'issue' : 'note' }));
  }
  async inlineComments(number: number): Promise<RemoteComment[]> {
    if (this.config.platform === 'github') return (await this.api.pages(`${this.root}/pulls/${number}/comments`)).map(c => ({ id: String(c.id), body: String(c.body ?? ''), author: String(c.user?.login), url: c.html_url ?? '', parentId: c.in_reply_to_id ? String(c.in_reply_to_id) : undefined, surface: 'review' }));
    const discussions = await this.api.pages(`${this.root}/merge_requests/${number}/discussions`);
    return discussions.filter(d => d.individual_note !== true).flatMap(d => (d.notes ?? []).map((n: any) => ({ id: String(n.id), body: String(n.body ?? ''), author: String(n.author?.username), url: this.noteUrl(number, n.id), discussionId: String(d.id), surface: 'note' })));
  }
  private noteUrl(number: number, id: number): string {
    return `${this.config.instance}/${this.config.repository.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${number}#note_${id}`;
  }
  async identity(): Promise<string> {
    const response = await this.api.request('/user');
    const username = this.config.platform === 'github' ? response.login : response.username;
    if (typeof username !== 'string' || !username) throw new Error('인증 계정 확인 실패');
    return username;
  }
  owned(c: RemoteComment): boolean { return sameLogin(c.author, this.config.botLogin) && hasOutputMarker(c.body); }
  async comment(number: number, body: string, id?: string): Promise<unknown> {
    const gh = this.config.platform === 'github';
    const path = id ? `${this.root}/${gh ? 'issues/comments' : `merge_requests/${number}/notes`}/${encodeURIComponent(id)}` : `${this.root}/${gh ? 'issues' : 'merge_requests'}/${number}/${gh ? 'comments' : 'notes'}`;
    return this.api.request(path, id ? (gh ? 'PATCH' : 'PUT') : 'POST', { body });
  }
  async inline(s: Snapshot, value: InlineInput): Promise<unknown> {
    if (this.config.platform === 'github') {
      return this.api.request(`${this.root}/pulls/${s.number}/comments`, 'POST', { commit_id: s.headSha, path: value.path, line: value.suggestion?.endLine ?? value.line, side: value.side ?? 'RIGHT', body: value.body,
        ...(value.suggestion && value.suggestion.startLine !== value.suggestion.endLine ? { start_line: value.suggestion.startLine, start_side: 'RIGHT' } : {}) });
    }
    return this.api.request(`${this.root}/merge_requests/${s.number}/discussions`, 'POST', { body: value.body,
      position: { position_type: 'text', base_sha: s.baseSha, start_sha: s.startSha, head_sha: s.headSha, old_path: value.oldPath, new_path: value.path,
        ...(value.coordinates ? { ...(value.coordinates.oldLine ? { old_line: value.coordinates.oldLine } : {}), ...(value.coordinates.newLine ? { new_line: value.coordinates.newLine } : {}) } : value.side === 'LEFT' ? { old_line: value.line } : { new_line: value.line }) } });
  }
  async reply(number: number, body: string, parentId: string | null, discussionId: string | null, questionThread?: Omit<InlineInput, 'body'> & { snapshot: Snapshot }): Promise<unknown> {
    if (questionThread) {
      if (this.config.platform === 'gitlab') return this.api.request(`${this.root}/merge_requests/${number}/discussions`, 'POST', { body });
      // Rename-only changes have no line coordinates; file-level review comments still support replies.
      if (!questionThread.coordinates) return this.api.request(`${this.root}/pulls/${number}/comments`, 'POST', {
        body, commit_id: questionThread.snapshot.headSha, path: questionThread.path, subject_type: 'file',
      });
      return this.inline(questionThread.snapshot, { ...questionThread, body });
    }
    if (this.config.platform === 'github' && parentId) return this.api.request(`${this.root}/pulls/${number}/comments/${encodeURIComponent(parentId)}/replies`, 'POST', { body });
    if (this.config.platform === 'gitlab' && discussionId) return this.api.request(`${this.root}/merge_requests/${number}/discussions/${encodeURIComponent(discussionId)}/notes`, 'POST', { body });
    return this.comment(number, body);
  }
  async permission(username: string, authorId?: number): Promise<'none' | 'write' | 'maintain'> {
    if (!username) return 'none';
    try {
      if (this.config.platform === 'github') {
        const p = await this.api.request(`${this.root}/collaborators/${encodeURIComponent(username)}/permission`);
        if (['admin', 'maintain'].includes(p.role_name) || ['admin', 'maintain'].includes(p.permission) || p.user?.permissions?.maintain || p.user?.permissions?.admin) return 'maintain';
        return p.permission === 'write' ? 'write' : 'none';
      }
      const id = authorId ?? (await this.api.request(`/users?username=${encodeURIComponent(username)}`))
        .find((user: { username: string }) => sameLogin(user.username, username))?.id;
      if (!Number.isSafeInteger(id) || id < 1) return 'none';
      const member = await this.api.request(`${this.root}/members/all/${id}`);
      return member.access_level >= 40 ? 'maintain' : member.access_level >= 30 ? 'write' : 'none';
    } catch (e) { if (e instanceof HttpError && [403, 404].includes(e.status) && !e.retryAt) return 'none'; throw e; }
  }
  async gateStatus(s: Snapshot): Promise<{ state: string; description: string } | null> {
    if (this.config.platform === 'github') {
      const combined = await this.api.request(`${this.root}/commits/${s.headSha}/status`);
      const status = (combined.statuses ?? []).find((c: any) => c.context === GATE_CONTEXT);
      return status ? { state: String(status.state), description: String(status.description ?? '') } : null;
    }
    const statuses = await this.api.pages(`${this.root}/repository/commits/${s.headSha}/statuses?name=${encodeURIComponent(GATE_CONTEXT)}&all=true`);
    const status = statuses.sort((a, b) => Number(b.id) - Number(a.id))[0];
    return status ? { state: String(status.status), description: String(status.description ?? '') } : null;
  }
  async setGateStatus(s: Snapshot, gate: GateStatus): Promise<void> {
    if (this.config.platform === 'github') {
      await this.api.request(`${this.root}/statuses/${s.headSha}`, 'POST', { state: gate.state, context: GATE_CONTEXT, description: gate.description.slice(0, 140), target_url: s.webUrl }); return;
    }
    // Attach to the MR's own pipeline so the status does not create a separate pipeline that hides CI jobs.
    const pipeline = (await this.api.pages(`${this.root}/merge_requests/${s.number}/pipelines`)).find(p => p.sha === s.headSha && p.source !== 'external');
    await this.api.request(`${this.root}/statuses/${s.headSha}`, 'POST', { state: gate.state, name: GATE_CONTEXT, description: gate.description.slice(0, 255), target_url: s.webUrl, ...(pipeline ? { pipeline_id: Number(pipeline.id) } : {}) });
  }
  async linkedIssues(description: string): Promise<string[]> {
    const ids = [...new Set([...description.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m => m[1]!))].slice(0, 5);
    return Promise.all(ids.map(async id => {
      try { const issue = await this.api.request(`${this.root}/issues/${id}`); return `#${id}: ${String(issue.title ?? '')}\n${String(issue.body ?? issue.description ?? '').slice(0, 6000)}`; }
      catch { return `#${id}: 연결된 이슈 확인 불가`; }
    }));
  }
}
