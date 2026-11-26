import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  let updated = '2025-01-01T00:00:00.000Z', created = updated, merged = null, state = gitlab ? 'opened' : 'open', lost = false, lostNotification = false, limited = false, activityUnavailable = false;
  let stateEventsUnavailable = false, hideChange = false;
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
      assert.equal(gitlab ? req.headers['private-token'] : req.headers.authorization, gitlab ? safeToken : `Bearer ${safeToken}`);
      requests.push([req.method, path, Number(url.searchParams.get('page') || 1), url.searchParams.get('after')]);
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') ?? 100);
      const paginated = rows => json(rows.slice((page - 1) * per, page * per));
      const pull = { number: 1, iid: 1, state, created_at: created, updated_at: updated, merged_at: merged, title: '결제', body: '결제 변경', description: '결제 변경',
        head: { sha: head }, base: { sha: base }, merged: Boolean(merged), merge_commit_sha: head, html_url: `${origin}/owner/repo/pull/1`, web_url: `${origin}/owner/repo/-/merge_requests/1`,
        diff_refs: { head_sha: head, base_sha: base, start_sha: base }, user: { login: 'owner' }, author: { username: 'owner', name: 'Owner' } };
      if (path === '/user' || path === '/api/v4/user') return json({ login: 'owner', username: 'owner', id: 3 });
      if (path === '/api/v4/users') return json([{ id: 3, username: 'owner' }]);
      const root = gitlab ? '/api/v4/projects/owner%2Frepo' : '/repos/owner/repo';
      if (!path.startsWith(root)) return json({ message: 'not found' }, 404);
      const route = path.slice(root.length);
      if (!route) return json({ id: 1, web_url: `${origin}/owner/repo` });
      if (route.startsWith('/collaborators/')) return json({ permission: route.includes('/visitor/') ? 'read' : 'write' });
      if (route === '/members/all/3') return json({ access_level: 30 });
      if (route === (gitlab ? '/merge_requests' : '/pulls')) {
        const after = url.searchParams.get('updated_after');
        return paginated(!hideChange && (!after || Date.parse(updated) >= Date.parse(after)) ? [pull] : []);
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
      if (route.endsWith('/resource_state_events')) return stateEventsUnavailable ? json({}, 404) : paginated(transitions);
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
  return { cli, cliWith, env, dir, origin, general, review, statuses, requests, modelCalls, notices,
    disableStateEvents: () => { stateEventsUnavailable = true; },
    hideChange: value => { hideChange = value; },
    touch: () => { updated = new Date().toISOString(); },
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


for (const forge of ['github', 'gitlab']) {
  test(`${forge} notification controls preserve the queue, deduplication and learning flows`, async t => {
    const f = await localFixture(t, forge);
    const connect = (...flags) => f.cli('connect', forge, 'owner/repo', '--publisher', 'owner', '--instance', f.origin,
      '--notify', 'webhook', '--notify-url-env', 'FIXTURE_WEBHOOK', ...flags);
    const watch = () => f.cli('watch', '--once');
    const db = () => new DatabaseSync(join(f.env.HEYBOT_HOME, 'state.sqlite'));
    const makeNotificationsDue = () => {
      const state = db();
      try { state.exec("UPDATE notifications SET due=0 WHERE state='queued'"); }
      finally { state.close(); }
    };
    await connect();
    await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
    await watch();
    f.create();
    f.note('visible by default');
    await watch();
    assert.deepEqual(f.notices.map(item => item.event).sort(), ['commented', 'opened']);
    assert.match(f.notices.find(item => item.event === 'commented').text, /visible by default/);

    const queued = f.note('stale preview');
    f.push('pushed', 'queuedBranch');
    await f.cliWith({ FIXTURE_WEBHOOK: '' })('watch', '--once');
    assert.equal(f.notices.length, 2);
    const state = db();
    try {
      assert.match(state.prepare("SELECT group_concat(payload) AS payloads FROM notifications WHERE state='queued'").get().payloads, /stale preview/);
    } finally { state.close(); }

    const watchLock = new DatabaseSync(join(f.env.HEYBOT_HOME, 'watch-lock.sqlite'));
    try {
      watchLock.exec('BEGIN IMMEDIATE');
      await assert.rejects(connect('--no-notify-comment-preview'), /이미 heybot_local이 실행 중/);
    } finally { watchLock.close(); }
    await assert.rejects(connect('--notify-events', 'commented,typo'), /notifications\.events\.1/);
    await assert.rejects(f.cli('connect', forge, 'owner/repo', '--publisher', 'owner', '--instance', f.origin,
      '--no-notify-comment-preview'), error => /--notify에 알림 서비스를 지정/.test(error.stderr));
    await connect('--notify-events', 'commented', '--no-notify-comment-preview');
    const filtered = db();
    try {
      assert.equal(filtered.prepare("SELECT count(*) AS count FROM notifications WHERE state='queued' AND json_type(payload,'$.preview') IS NOT NULL").get().count, 0);
      assert.equal(filtered.prepare("SELECT count(*) AS count FROM notifications WHERE state='skipped' AND error='event_filtered'").get().count, 1);
    } finally { filtered.close(); }
    makeNotificationsDue();
    const reply = f.reply({ id: null, discussion_id: 'thread-human' }, 'new private preview');
    f.note('/hey help');
    f.merge();
    f.push('pushed', 'whileFiltered');
    f.push('created', 'oldNewBranch');
    const requestStart = f.requests.length;
    await watch();
    assert.equal(f.requests.slice(requestStart).some(([, path]) => /\/(activity|events)$/.test(path)), false);
    assert.equal(f.modelCalls.length, 1);
    assert.equal(f.general.filter(c => c.body.includes('codereviewbot:summary')).length, 1);
    assert.equal(f.general.filter(c => c.body.includes('codereviewbot:reply:')).length, 1);
    assert.deepEqual(f.notices.slice(2).map(item => item.event), ['commented', 'commented', 'commented']);
    const [older, ...newer] = f.notices.slice(2);
    assert.ok(older.text.includes(forge === 'github' ? `#issuecomment-${queued.id}` : `#note_${queued.id}`));
    assert.ok(newer.some(item => item.text.includes(forge === 'github' ? `#discussion_r${reply.id}` : `#note_${reply.id}`)));
    for (const item of f.notices.slice(2)) {
      assert.match(item.text, /owner.*댓글을 남겼어요/);
      assert.doesNotMatch(item.text, /stale preview|new private preview|\/hey help|\*“/);
    }

    await connect('--notify-events', 'commented,push,questions');
    await delay(2);
    f.push('pushed', 'freshPush');
    f.push('created', 'stillFilteredCreation');
    f.note('preview restored');
    await watch();
    await watch();
    assert.deepEqual(f.notices.slice(5).map(item => item.event).sort(), ['commented', 'push']);
    assert.ok(f.notices.some(item => item.text.includes('freshPush')));
    assert.ok(f.notices.some(item => item.text.includes('preview restored')));
    assert.doesNotMatch(f.notices.map(item => item.text).join('\n'), /queuedBranch|whileFiltered|oldNewBranch|stillFilteredCreation/);

    const last = f.note('queued between restarts');
    await f.cliWith({ FIXTURE_WEBHOOK: '' })('watch', '--once');
    f.close();
    f.open();
    await connect('--notify-events', 'commented,push,questions', '--no-notify-comment-preview');
    await connect('--notify-events', 'branch-created,commented,questions,reopened');
    makeNotificationsDue();
    await delay(2);
    f.close();
    f.open();
    f.push('created', 'freshNewBranch');
    f.push('pushed', 'ignoredPush');
    await watch();
    assert.deepEqual(f.notices.slice(7).map(item => item.event), ['commented', 'reopened', 'push']);
    assert.ok(f.notices[7].text.includes(forge === 'github' ? `#issuecomment-${last.id}` : `#note_${last.id}`));
    assert.doesNotMatch(f.notices[7].text, /queued between restarts/);
    assert.match(f.notices[9].text, /freshNewBranch/);
    assert.doesNotMatch(f.notices.map(item => item.text).join('\n'), /oldNewBranch|stillFilteredCreation|ignoredPush/);
    assert.equal(new Set(f.notices.map(item => item.id)).size, f.notices.length);
  });
}

test('GitLab fallback does not date an old transition from a later update after re-enabling an alert', async t => {
  const f = await localFixture(t, 'gitlab');
  const select = event => f.cli('connect', 'gitlab', 'owner/repo', '--publisher', 'owner', '--instance', f.origin,
    '--notify', 'webhook', '--notify-url-env', 'FIXTURE_WEBHOOK', '--notify-events', event);
  const watch = () => f.cli('watch', '--once');
  f.disableStateEvents();
  await select('closed');
  await f.cli('model', 'ollama', '--model', 'fixture', '--url', f.origin);
  await watch();
  const legacy = new DatabaseSync(join(f.env.HEYBOT_HOME, 'state.sqlite'));
  try { legacy.exec("UPDATE mr_states SET state='opened'"); }
  finally { legacy.close(); }
  f.close();
  await watch();
  assert.deepEqual(f.notices.map(item => item.event), ['closed']);
  f.open();
  await watch();
  await select('commented');
  f.close();
  await watch();
  await select('closed');
  f.hideChange(true);
  await watch();
  f.hideChange(false);
  f.touch();
  await watch();
  assert.equal(f.notices.length, 1);
  f.open();
  await watch();
  f.close();
  await watch();
  assert.deepEqual(f.notices.map(item => item.event), ['closed', 'closed']);
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
