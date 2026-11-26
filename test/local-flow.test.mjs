import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { initialQuestions, answerKey } from './fixtures.mjs';
import { repositoryWebBase } from '../dist/config.js';
import { renderNotification } from '../dist/notifications.js';

const execFile = promisify(execFileCallback);
async function makeGitFixture(dir, gitlab = false) {
  const repo = join(dir, 'fixture');
  await mkdir(join(repo, 'src'), { recursive: true });
  const git = async (...args) => (await execFile('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await writeFile(join(repo, 'src/pay.ts'), 'function pay() {\n  save();\n}\n');
  await writeFile(join(repo, '.hey.yaml'), 'requireAnswers: true\nexclude: ["**/*.private"]\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'src/pay.ts'), 'function pay() {\n  charge();\n  save();\n}\n');
  await writeFile(join(repo, '.env'), 'SHOULD_NEVER_REACH_MODEL=yes');
  await writeFile(join(repo, '.hey.yaml'), 'requireAnswers: false\n');
  await writeFile(join(repo, 'fixture.private'), 'BASE_POLICY_MUST_EXCLUDE_ME=yes');
  await git('add', '.');
  await git('commit', '-m', 'charge');
  const head = await git('rev-parse', 'HEAD');
  await git('update-ref', gitlab ? 'refs/merge-requests/1/head' : 'refs/pull/1/head', head);
  await git('update-server-info');
  return { base, head, objects: join(repo, '.git') };
}
const safeToken = 'fixture-forge-token';
const defaultCommand = process.env.HEYBOT_PACKED_BIN ? [process.env.HEYBOT_PACKED_BIN] : [process.execPath, new URL('../dist/cli.js', import.meta.url).pathname];
export async function localFixture(t, kind, command = defaultCommand) {
  const gitlab = kind === 'gitlab';
  const dir = await mkdtemp(join(tmpdir(), 'heybot-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, head, objects } = await makeGitFixture(dir, gitlab);
  let nextNote = 1;
  const general = [], review = [], modelCalls = [], statuses = [], requests = [], notices = [], transitions = [], pushes = [];
  const access = { login: 'owner', githubScopes: 'repo', gitlabScopes: ['api'], gitlabRole: 30, commitsStatus: 200 };
  let updated = '2025-01-01T00:00:00.000Z', created = updated, merged = null, state = gitlab ? 'opened' : 'open', lost = false, lostNotification = false, limited = false, activityUnavailable = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      let input = '';
      for await (const chunk of req) input += chunk;
      const body = input ? JSON.parse(input) : undefined;
      const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (path.startsWith('/owner/repo.git/')) {
        const name = path.slice('/owner/repo.git/'.length);
        assert.match(name, /^(?:HEAD|info\/refs|objects\/[a-z0-9/.-]+)$/);
        try { const value = await readFile(join(objects, name)); res.writeHead(200); res.end(value); } catch { res.writeHead(404); res.end(); }
        return;
      }
      if (path === '/hooks/fixture') {
        notices.push(body);
        if (lostNotification) { lostNotification = false; req.socket.destroy(); return; }
        return json({ ok: true });
      }
      if (path === '/api/tags') return json({ models: [{ name: 'fixture:latest', digest: '0'.repeat(64), size: 42 }] });
      if (path === '/api/chat') {
        modelCalls.push(body);
        assert.equal(body.model, 'fixture');
        assert.ok(body.format.properties);
        assert.equal(req.headers.authorization, undefined);
        assert.doesNotMatch(body.messages[0].content, /SHOULD_NEVER_REACH_MODEL|BASE_POLICY_MUST_EXCLUDE_ME|fixture-forge-token/);
        return json({ done: true, message: { content: JSON.stringify({ questions: initialQuestions() }) } });
      }
      requests.push([req.method, path, Number(url.searchParams.get('page') || 1), url.searchParams.get('after')]);
      if ((gitlab ? req.headers['private-token'] : req.headers.authorization) !== (gitlab ? safeToken : `Bearer ${safeToken}`)) {
        return json({ message: `Rejected credentials: ${req.headers['private-token'] ?? req.headers.authorization}` }, 401);
      }
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') ?? 100);
      const paginated = rows => json(rows.slice((page - 1) * per, page * per));
      const pull = { number: 1, iid: 1, state, created_at: created, updated_at: updated, merged_at: merged, title: '결제', body: '결제 변경', description: '결제 변경',
        head: { sha: head }, base: { sha: base }, merged: Boolean(merged), merge_commit_sha: head, html_url: `${origin}/owner/repo/pull/1`, web_url: `${origin}/owner/repo/-/merge_requests/1`,
        diff_refs: { head_sha: head, base_sha: base, start_sha: base }, user: { login: 'owner' }, author: { username: 'owner', name: 'Owner' } };
      if (path === '/user' || path === '/api/v4/user') {
        if (!gitlab && access.githubScopes !== null) res.setHeader('x-oauth-scopes', access.githubScopes);
        res.setHeader('x-accepted-github-permissions', 'pull_requests=write, commit_statuses=write');
        return json({ login: access.login, username: access.login, id: 3 });
      }
      if (path === '/api/v4/users') return json([{ id: 3, username: 'owner' }]);
      if (path === '/api/v4/personal_access_tokens/self') return access.gitlabScopes
        ? json({ scopes: access.gitlabScopes }) : json({ message: 'Metadata endpoint unavailable' }, 404);
      const root = gitlab ? '/api/v4/projects/owner%2Frepo' : '/repos/owner/repo';
      if (!path.startsWith(root)) return json({ message: 'not found' }, 404);
      const route = path.slice(root.length);
      if (!route) return json({ id: 1, private: true, visibility: 'private', permissions: { push: true }, web_url: `${origin}/owner/repo` });
      if (route === (gitlab ? '/repository/commits' : '/commits')) {
        return access.commitsStatus === 200 ? json([{ [gitlab ? 'id' : 'sha']: head }]) : json({ message: safeToken }, access.commitsStatus);
      }
      if (route.startsWith('/collaborators/')) return json({ permission: route.includes('/visitor/') ? 'read' : 'write' });
      if (route === '/members/all/3') return json({ access_level: access.gitlabRole });
      if (route === (gitlab ? '/merge_requests' : '/pulls')) {
        const after = url.searchParams.get('updated_after');
        return paginated(!after || Date.parse(updated) >= Date.parse(after) ? [pull] : []);
      }
      if (route === (gitlab ? '/merge_requests/1' : '/pulls/1')) return json(pull);
      if (route.startsWith('/compare/')) {
        if (!url.searchParams.has('per_page')) return json({ merge_base_commit: { sha: base } });
        if (route.includes('e'.repeat(40))) return json({ message: 'old object unreachable' }, 404);
        return json({ total_commits: 2, commits: [
          { sha: head, commit: { message: 'fix: 결제 처리', committer: { date: updated } }, parents: [{ sha: base }] },
          { sha: '9'.repeat(40), commit: { message: '병합 개수 제외', committer: { date: updated } }, parents: [{ sha: base }, { sha: head }] },
        ] });
      }
      if (route === '/activity') {
        if (activityUnavailable) return json({ message: 'activity endpoint unavailable' }, 404);
        const start = Number(url.searchParams.get('after')?.split('+')[1] ?? 0);
        const entries = pushes.toReversed();
        if (start + 2 < entries.length) {
          res.setHeader('link', `<${origin}/repositories/123/activity?after=fixture%2B${start + 2}>; rel="next"`);
        }
        return json(entries.slice(start, start + 2));
      }
      if (route === '/issues/1/timeline') return paginated(transitions);
      if (route.endsWith('/status')) return json({ statuses: statuses.map(status => ({ ...status, context: status.context })).slice(-1) });
      if (route === `/commits/${head}`) return json({ parents: [{ sha: base }] });
      if (route === `/repository/commits/${head}/statuses`) return paginated(statuses.map((s, i) => ({ ...s, status: s.state, id: i + 1 })));
      if (route === `/statuses/${head}`) { statuses.push(body); return json(body, 201); }
      if (route === '/merge_requests/1/pipelines') return paginated([]);
      if (route === '/events') return paginated(pushes.toReversed());
      if (route.endsWith('/resource_state_events')) return paginated(transitions);
      if (route === '/repository/compare') {
        assert.equal(url.searchParams.get('straight'), 'true');
        assert.equal(url.searchParams.get('from'), base);
        assert.equal(url.searchParams.get('to'), head);
        return json({ commits: [
          { id: head, title: 'fix: 결제 처리', committed_date: updated, parent_ids: [base] },
          { id: '9'.repeat(40), title: '이 제목은 병합처럼 보이지 않음', committed_date: updated, parent_ids: [base, head] },
        ] });
      }
      if (route === '/issues/comments' && limited) {
        limited = false;
        res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return;
      }
      if (route === '/issues/comments' || route === '/pulls/comments') {
        const since = Date.parse(url.searchParams.get('since'));
        return paginated((route.startsWith('/issues') ? general : review).filter(row => Date.parse(row.updated_at) > since));
      }
      if (route === '/issues/1/comments' || route === '/merge_requests/1/notes') {
        if (req.method === 'GET') return paginated(gitlab ? [...general, ...review] : general);
        const row = add(general, body.body);
        return json(row, 201);
      }
      if ((route.startsWith('/issues/comments/') || route.startsWith('/merge_requests/1/notes/')) && ['PATCH', 'PUT'].includes(req.method)) {
        const row = general.find(value => value.id === Number(route.split('/').at(-1)));
        row.body = body.body;
        return json(row);
      }
      if (route === '/pulls/1/comments' || route === '/merge_requests/1/discussions') {
        if (req.method === 'GET') {
          if (!gitlab) return paginated(review);
          const groups = Map.groupBy(review, note => note.discussion_id);
          return paginated([
            ...general.map(note => ({ id: `standalone-${note.id}`, individual_note: true, notes: [note] })),
            ...[...groups].map(([id, notes]) => ({ id, individual_note: false, notes })),
          ]);
        }
        const row = add(review, body.body, null, 'owner', `thread${review.length}`);
        if (lost) { lost = false; req.socket.destroy(); return; }
        return json(row, 201);
      }
      const reply = route.match(/\/pulls\/1\/comments\/(\d+)\/replies$/) || route.match(/\/merge_requests\/1\/discussions\/([^/]+)\/notes$/);
      if (reply) return json(add(review, body.body, gitlab ? null : Number(reply[1]), 'owner', gitlab ? reply[1] : undefined), 201);
      return json({ route }, 404);
    } catch (error) { res.writeHead(500); res.end(); t.diagnostic(error.stack); }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const add = (surface, body, parent = null, author = 'owner', discussion) => {
    const now = new Date().toISOString(), id = gitlab ? nextNote++ : surface.length + 1;
    const row = { id, body, created_at: now, updated_at: now, user: { login: author, type: 'User' }, author: { username: author, name: author },
      issue_url: `${origin}/repos/owner/repo/issues/1`, pull_request_url: `${origin}/repos/owner/repo/pulls/1`,
      html_url: `${origin}/owner/repo/pull/1#comment-${id}`, in_reply_to_id: parent, discussion_id: discussion };
    surface.push(row);
    return row;
  };
  const env = { ...process.env, HEYBOT_HOME: join(dir, 'profile'), GITHUB_TOKEN: safeToken, GITLAB_TOKEN: safeToken,
    FIXTURE_WEBHOOK: `${origin}/hooks/fixture` };
  const cliWith = (overrides = {}) => async (...args) => execFile(command[0], [...command.slice(1), ...args], { env: { ...env, ...overrides }, timeout: 25000 });
  const cli = cliWith();
  const transition = status => {
    updated = new Date().toISOString();
    transitions.push({ id: transitions.length + 1, state: status, event: status === 'open' ? 'reopened' : status, created_at: updated });
    state = status;
  };
  return { cli, cliWith, env, dir, origin, general, review, statuses, requests, modelCalls, notices, access,
    open: () => transition(gitlab ? 'opened' : 'open'),
    create: () => { created = updated = new Date().toISOString(); state = gitlab ? 'opened' : 'open'; },
    close: () => transition('closed'),
    push: (action, ref = 'main') => {
      const id = pushes.length + 1, created_at = new Date().toISOString();
      const activityTypes = { created: 'branch_creation', removed: 'branch_deletion', force: 'force_push', merged: 'pr_merge' };
      pushes.push(gitlab ? {
        id, created_at, author: { name: '이개발 (팀)' }, push_data: action === 'bulk' ? { ref_count: 3 } : {
          action, ref_type: 'branch', ref, commit_count: 2, commit_from: action === 'created' ? null : base,
          commit_to: action === 'removed' ? null : head,
        },
      } : { id, timestamp: created_at, activity_type: activityTypes[action] ?? 'push', ref: ref.startsWith('refs/') ? ref : `refs/heads/${ref}`,
        before: action === 'created' ? '0'.repeat(40) : action === 'force' ? 'e'.repeat(40) : base,
        after: action === 'removed' ? '0'.repeat(40) : head, actor: { login: 'owner' } });
    },
    merge: () => {
      updated = merged = new Date().toISOString();
      state = gitlab ? 'merged' : 'closed';
      if (!gitlab) for (const event of ['merged', 'closed']) transitions.push({ id: transitions.length + 1, event, created_at: updated });
    },
    oldMerge: () => { state = gitlab ? 'merged' : 'closed'; merged = updated; },
    note: (body, author) => add(general, body, null, author),
    reply: (root, body) => add(review, body, root.id, 'owner', root.discussion_id),
    disableActivity: () => { activityUnavailable = true; }, loseWrite: () => { lost = true; }, loseNotification: () => { lostNotification = true; }, rateLimit: () => { limited = true; } };
}

export async function runFlow(t, platform, bin) {
  const f = await localFixture(t, platform, bin);
  f.oldMerge();
  await f.cli('connect', platform, 'owner/repo', '--publisher', 'owner', '--instance', f.origin);
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 0, 'existing merges are not backfilled');
  f.open();
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 0, 'opening or reopening is not automatic generation');
  f.merge();
  const first = await f.cli('watch', '--once');
  assert.doesNotMatch(first.stderr, /조회 실패|jobId/);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.review.length, 2);
  const summary = f.general.find(c => c.body.includes('codereviewbot:summary'));
  assert.match(summary.body, /#### Q1\./);
  assert.doesNotMatch(summary.body, new RegExp(answerKey().explanation));
  f.note('/hey answer Q1 B Q2 A');
  f.reply(f.review[0], '/hey showanswer');
  f.note('/hey help', 'visitor');
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 1);
  assert.ok(f.general.some(c => c.body.includes('### Q1 · ✅ 정답') && c.body.includes('### Q2 · ❌ 오답')));
  const reveal = f.review.find(c => c.body.includes('##### 해설'));
  assert.match(reveal.body, /#### Q1\./);
  assert.doesNotMatch(reveal.body, /#### Q2\./);
  if (platform === 'github') assert.ok(!f.general.some(c => c.body.includes('| 명령어 |')));
  const writesBefore = f.requests.filter(([method]) => method !== 'GET').length;
  await f.cli('watch', '--once');
  assert.equal(f.requests.filter(([method]) => method !== 'GET').length, writesBefore);
  assert.equal(JSON.parse((await f.cli('status')).stdout).failures.length, 0);
}

test('GitHub CLI discovers a merge and both comment surfaces across restarts', async t => {
  await runFlow(t, 'github');
});

test('GitLab CLI discovers an MR merge and notes and discussion replies on a merged MR', async t => {
  await runFlow(t, 'gitlab');
});

for (const forge of ['github', 'gitlab']) {
  test(`doctor reads ${forge} and checks webhook configuration without writing or delivering`, async t => {
    const f = await localFixture(t, forge);
    await f.cli('connect', forge, 'owner/repo', '--publisher', 'OWNER', '--instance', f.origin,
      '--notify', 'webhook', '--notify-url-env', 'FIXTURE_WEBHOOK');
    await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
    const files = await readdir(f.env.HEYBOT_HOME);
    const config = await readFile(join(f.env.HEYBOT_HOME, 'config.json'), 'utf8');
    const start = f.requests.length;

    const { stdout, stderr } = await f.cli('doctor');
    assert.match(stdout, /\[확인\] 토큰.*인증/);
    assert.match(stdout, /\[확인\] 게시 계정.*일치/);
    assert.match(stdout, /\[확인\] 저장소 읽기/);
    assert.match(stdout, /\[메타데이터\] 댓글 쓰기.*실제 쓰기 확인 필요/);
    assert.match(stdout, /\[메타데이터\] 커밋 상태 쓰기.*실제 쓰기 확인 필요/);
    assert.match(stdout, /\[확인\] 웹훅.*형식.*수신 확인 필요/);
    assert.match(stdout, /\[확인\] 모델.*Ollama.*로컬/);
    assert.ok(!(stdout + stderr).includes(safeToken));
    assert.ok(!(stdout + stderr).includes(f.env.FIXTURE_WEBHOOK));
    assert.ok(f.requests.slice(start).every(([method]) => method === 'GET'));
    assert.ok(f.requests.slice(start).some(([, path]) => path.endsWith('/commits')));
    assert.equal(f.notices.length, 0);
    assert.equal(f.modelCalls.length, 0);
    assert.deepEqual(await readdir(f.env.HEYBOT_HOME), files);
    assert.equal(await readFile(join(f.env.HEYBOT_HOME, 'config.json'), 'utf8'), config);

    if (forge === 'github') f.access.githubScopes = null;
    else f.access.gitlabScopes = null;
    const limitedMetadata = (await f.cli('doctor')).stdout;
    assert.match(limitedMetadata, /\[확인 필요\] 댓글 쓰기/);
    assert.match(limitedMetadata, /\[확인 필요\] 커밋 상태 쓰기/);

    if (forge === 'github') f.access.githubScopes = 'repo:status';
    else f.access.gitlabScopes = ['read_api'];
    await assert.rejects(f.cli('doctor'), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /\[실패\] 댓글 쓰기.*권한 범위/);
      assert.match(error.stdout, forge === 'github' ? /\[메타데이터\] 커밋 상태 쓰기/ : /\[실패\] 커밋 상태 쓰기.*권한 범위/);
      return true;
    });

    if (forge === 'github') {
      f.access.githubScopes = 'repo';
      f.access.login = safeToken;
    } else {
      f.access.gitlabScopes = ['api'];
      f.access.gitlabRole = 20;
    }
    await assert.rejects(f.cli('doctor'), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, forge === 'github' ? /\[실패\] 게시 계정/ : /\[실패\] 커밋 상태 쓰기.*Developer/);
      assert.ok(!(error.stdout + error.stderr).includes(safeToken));
      return true;
    });
  });
}

test('doctor reports independent connection failures without exposing authentication or URL details', async t => {
  const github = await localFixture(t, 'github');
  const gitlab = await localFixture(t, 'gitlab');
  await github.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', github.origin,
    '--notify', 'webhook', '--notify-url-env', 'FIXTURE_WEBHOOK');
  await github.cli('connect', 'gitlab', 'owner/repo', '--publisher', 'other', '--observe', '--instance', gitlab.origin);
  await github.cli('model', 'claude', '--model', 'fixture', '--key-env', 'FIXTURE_CLAUDE_KEY');
  gitlab.access.commitsStatus = 403;
  const invalidToken = 'fixture-invalid-forge-token';
  const invalidHook = `${github.env.FIXTURE_WEBHOOK}?secret=fixture-webhook-secret`;
  await assert.rejects(github.cliWith({ GITHUB_TOKEN: invalidToken, FIXTURE_WEBHOOK: invalidHook, FIXTURE_CLAUDE_KEY: '' })('doctor'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /\[실패\] 토큰.*HTTP 401/);
    assert.match(error.stdout, /\[실패\] 웹훅.*형식/);
    assert.match(error.stdout, /\[확인\] 계정.*관찰 모드/);
    assert.match(error.stdout, /\[실패\] 저장소 읽기.*HTTP 403/);
    assert.match(error.stdout, /\[건너뜀\] 댓글 쓰기.*관찰 모드/);
    assert.match(error.stdout, /\[실패\] 모델.*FIXTURE_CLAUDE_KEY/);
    for (const value of [safeToken, invalidToken, invalidHook, 'fixture-webhook-secret']) {
      assert.ok(!(error.stdout + error.stderr).includes(value));
    }
    return true;
  });
  assert.equal(github.notices.length, 0);
  assert.equal(gitlab.notices.length, 0);
});

test('a paginated scan preserves its cursor when rate limited and resumes after reset', async t => {
  const f = await localFixture(t, 'github');
  await f.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin);
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  const before = JSON.parse((await f.cli('status')).stdout).cursors;
  for (let n = 0; n < 100; n++) f.note(`ordinary comment ${n}`);
  f.note('/reviewbot help');
  f.rateLimit();
  await assert.rejects(f.cli('watch', '--once'), /429/);
  assert.deepEqual(JSON.parse((await f.cli('status')).stdout).cursors, before);
  const requests = f.requests.length;
  await assert.rejects(f.cli('watch', '--once'), /rate limited/);
  assert.equal(f.requests.length, requests);
  await delay(1150);
  await f.cli('watch', '--once');
  assert.ok(f.requests.some(([, path, page]) => path === '/repos/owner/repo/issues/comments' && page === 2));
  assert.equal(f.general.filter(c => c.body.startsWith('<!-- codereviewbot:reply:issue-101 -->')).length, 1);
});

test('an accepted inline write with a lost response is reconciled after restart without another model call', async t => {
  const f = await localFixture(t, 'github');
  await f.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin);
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  f.merge();
  f.loseWrite();
  await f.cli('watch', '--once');
  assert.equal(f.review.length, 1);
  assert.equal(f.modelCalls.length, 1);
  const db = new DatabaseSync(join(f.env.HEYBOT_HOME, 'state.sqlite'));
  db.prepare("UPDATE jobs SET due=0 WHERE state='ready'").run();
  db.close();
  await f.cli('watch', '--once');
  assert.equal(f.review.length, 2);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.general.filter(c => c.body.includes('codereviewbot:summary')).length, 1);
});

test('the designated publisher posts while an observer stays read-only', async t => {
  const f = await localFixture(t, 'github');
  const observer = f.cliWith({ HEYBOT_HOME: join(f.dir, 'observer') });
  await assert.rejects(f.cli('connect', 'github', 'owner/repo', '--publisher', 'different', '--instance', f.origin), /게시 계정/);
  await f.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin);
  await observer('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin, '--observe');
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await Promise.all([f.cli('watch', '--once'), observer('watch', '--once')]);
  f.merge();
  await Promise.all([f.cli('watch', '--once'), observer('watch', '--once')]);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.general.filter(c => c.body.includes('codereviewbot:summary')).length, 1);
  assert.equal(JSON.parse((await observer('status')).stdout).jobs.length, 0);
});

test('requireAnswers reads the pinned target policy and marks the exact head successful after answers', async t => {
  const f = await localFixture(t, 'gitlab');
  await f.cli('connect', 'gitlab', 'owner/repo', '--publisher', 'owner', '--instance', f.origin);
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  f.note('/hey tryagain');
  await f.cli('watch', '--once');
  assert.equal(f.statuses.at(-1).state, 'pending');
  assert.equal(f.statuses.at(-1).name, 'codereviewbot/questions');
  f.note('/hey answer Q1 B Q2 A');
  await f.cli('watch', '--once');
  assert.deepEqual(f.statuses.map(status => status.state), ['pending', 'success']);
});

test('GitLab notifications cover lifecycle, people, questions, pushes and new branches without live webhooks', async t => {
  const f = await localFixture(t, 'gitlab');
  await f.cli('connect', 'gitlab', 'owner/repo', '--publisher', 'owner', '--instance', f.origin,
    '--notify', 'mattermost', '--notify-url-env', 'FIXTURE_WEBHOOK', '--notify-channel', 'learning');
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  assert.equal(f.notices.length, 0);
  f.create();
  await f.cli('watch', '--once');
  f.close();
  f.open();
  f.note('같은 계정의 사람 댓글 @here');
  f.push('pushed');
  f.push('created', 'topic');
  f.push('removed', 'deleted');
  f.push('bulk');
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 0);
  f.merge();
  await f.cli('watch', '--once');
  await f.cli('watch', '--once');
  const texts = f.notices.map(payload => payload.text);
  assert.equal(texts.length, 8);
  assert.ok(f.notices.every(payload => payload.channel === 'learning' && payload.username === 'hey'));
  for (const emoji of ['📬', '🗃️', '🔄', '🎉', '💬', '🧩', '🚀', '🌱']) assert.equal(texts.filter(text => text.includes(emoji)).length, 1);
  const comment = texts.find(text => text.includes('💬'));
  assert.match(comment, /#note_\d+/);
  assert.match(comment, /같은 계정의 사람 댓글/);
  assert.doesNotMatch(comment, /@here/);
  const pushed = texts.find(text => text.includes('🚀'));
  assert.match(pushed, /신규\/변경 커밋 1개/);
  assert.match(pushed, /결제 처리/);
  assert.doesNotMatch(pushed, /이 제목은 병합/);
  assert.ok(JSON.parse((await f.cli('status')).stdout).notifications.some(row => row.state === 'skipped' && row.count === 1));
});

for (const forge of ['github', 'gitlab']) for (const provider of ['slack', 'discord', 'webhook']) {
  test(`${forge} ${provider} is selectable and safely sends the provider's webhook payload`, async t => {
    const f = await localFixture(t, forge);
    await f.cli('connect', forge, 'owner/repo', '--publisher', 'owner', '--instance', f.origin, '--notify', provider, '--notify-url-env', 'FIXTURE_WEBHOOK');
    await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
    await f.cli('watch', '--once');
    f.note('댓글 <@everyone> & 그대로');
    if (provider === 'webhook') f.loseNotification();
    await f.cli('watch', '--once');
    await f.cli('watch', '--once');
    assert.equal(f.notices.length, 1);
    const [payload] = f.notices;
    if (provider === 'slack') {
      assert.match(payload.text, /<http:\/\/127\.0\.0\.1:[^|]+\|/);
      assert.doesNotMatch(payload.text, /<@everyone>/);
      assert.equal(payload.unfurl_links, false);
    } else if (provider === 'discord') {
      assert.deepEqual(payload.allowed_mentions, { parse: [] });
      assert.match(payload.embeds[0].description, /💬/);
    } else {
      assert.equal(payload.version, 1);
      assert.equal(payload.event, 'commented');
      assert.equal(payload[forge === 'github' ? 'pullRequest' : 'mergeRequest'], 1);
      assert.ok(JSON.parse((await f.cli('status')).stdout).notifications.some(row => row.state === 'uncertain'));
    }
  });
}

test('GitHub sends PR lifecycle, both comment surfaces, question, commit range and branch alerts exactly once', async t => {
  const f = await localFixture(t, 'github');
  f.push('created', 'historical');
  await f.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin,
    '--notify', 'mattermost', '--notify-url-env', 'FIXTURE_WEBHOOK');
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  assert.equal(f.notices.length, 0);
  f.create();
  await f.cli('watch', '--once');
  f.close();
  f.open();
  f.note('일반 PR 댓글 @everyone');
  f.note('일반 이슈 댓글').issue_url = `${f.origin}/repos/owner/repo/issues/999`;
  f.reply({ id: null }, '리뷰 댓글');
  f.push('pushed');
  f.push('created', 'topic/new');
  f.push('removed', 'gone');
  f.push('merged');
  f.push('pushed', 'refs/tags/v1');
  f.push('force', 'rewritten');
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 0);
  f.merge();
  await f.cli('watch', '--once');
  await f.cli('watch', '--once');
  assert.equal(f.modelCalls.length, 1);
  const texts = f.notices.map(payload => payload.text);
  assert.equal(texts.length, 10);
  for (const emoji of ['📬', '🗃️', '🔄', '🎉', '🧩', '🌱']) assert.equal(texts.filter(text => text.includes(emoji)).length, 1);
  assert.ok(texts.some(text => /일반 PR 댓글/.test(text) && /\/pull\/1#issuecomment-/.test(text)));
  assert.ok(texts.some(text => /리뷰 댓글/.test(text) && /\/pull\/1#discussion_r/.test(text)));
  assert.ok(texts.some(text => /신규\/변경 커밋 1개/.test(text) && /fix:.*결제 처리/.test(text)));
  assert.ok(texts.some(text => /커밋 수 확인 필요/.test(text) && /rewritten/.test(text)));
  const all = texts.join('\n');
  assert.doesNotMatch(all, /일반 이슈 댓글|@everyone|historical|병합 개수 제외|refs\/tags/);
  assert.match(all, /\/owner\/repo\/commits\/topic%2Fnew/);
  assert.match(all, /질문이 준비됐어요\.[\s\S]*?\/pull\/1#issuecomment-/);
  assert.ok(f.requests.some(([, path, , after]) => path === '/repos/owner/repo/activity' && after === 'fixture+2'));
  assert.ok(JSON.parse((await f.cli('status')).stdout).notifications.some(row => row.state === 'sent' && row.error === 'range_unavailable'));
});

test('an unavailable GitHub activity feed leaves merge questions and other notifications working', async t => {
  const f = await localFixture(t, 'github');
  await f.cli('connect', 'github', 'owner/repo', '--publisher', 'owner', '--instance', f.origin, '--notify', 'webhook', '--notify-url-env', 'FIXTURE_WEBHOOK');
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await f.cli('watch', '--once');
  f.disableActivity();
  f.merge();
  await assert.rejects(f.cli('watch', '--once'), /협업 알림 이벤트 조회 실패.*404/);
  assert.equal(f.modelCalls.length, 1);
  assert.deepEqual(f.notices.map(item => item.event).sort(), ['merged', 'questions']);
});

test('notification and Git browser URLs use the web hosts for common enterprise API endpoints', () => {
  for (const [instance, expected] of [
    ['https://api.github.com', 'https://github.com'],
    ['https://api.example.ghe.com', 'https://example.ghe.com'],
    ['https://github.example.com/api/v3', 'https://github.example.com'],
  ]) {
    const target = { platform: 'github', instance, repository: 'owner/repo', number: 5 };
    assert.equal(repositoryWebBase(target), expected);
    const text = renderNotification(target, { kind: 'commented', noteId: '3', title: 'Fixture', surface: 'review' }, 'user');
    assert.ok(text.includes(`${expected}/owner/repo/pull/5#discussion_r3`));
  }
  assert.equal(repositoryWebBase({ platform: 'gitlab', instance: 'https://git.example.com/gitlab' }), 'https://git.example.com/gitlab');
});
