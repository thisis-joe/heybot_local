import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initialQuestions, answerKey } from './fixtures.mjs';

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
export async function localFixture(t, kind, command = [process.execPath, new URL('../dist/cli.js', import.meta.url).pathname]) {
  const gitlab = kind === 'gitlab';
  const dir = await mkdtemp(join(tmpdir(), 'heybot-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, head, objects } = await makeGitFixture(dir, gitlab);
  const general = [], review = [], modelCalls = [], statuses = [], requests = [];
  let updated = '2025-01-01T00:00:00.000Z', merged = null, state = gitlab ? 'opened' : 'open', lost = false, limited = false;
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
      requests.push([req.method, path, Number(url.searchParams.get('page') || 1)]);
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') ?? 100);
      const paginated = rows => json(rows.slice((page - 1) * per, page * per));
      const pull = { number: 1, iid: 1, state, created_at: '2025-01-01T00:00:00.000Z', updated_at: updated, merged_at: merged, title: '결제', body: '결제 변경', description: '결제 변경',
        head: { sha: head }, base: { sha: base }, merged: Boolean(merged), merge_commit_sha: head, html_url: `${origin}/owner/repo/pull/1`, web_url: `${origin}/owner/repo/-/merge_requests/1`,
        diff_refs: { head_sha: head, base_sha: base, start_sha: base }, author: { username: 'owner', name: 'Owner' } };
      if (path === '/user' || path === '/api/v4/user') return json({ login: 'owner', username: 'owner', id: 3 });
      if (path === '/api/v4/users') return json([{ id: 3, username: 'owner' }]);
      const root = gitlab ? '/api/v4/projects/owner%2Frepo' : '/repos/owner/repo';
      if (!path.startsWith(root)) return json({ message: 'not found' }, 404);
      const route = path.slice(root.length);
      if (!route) return json({ id: 1, web_url: `${origin}/owner/repo` });
      if (route.startsWith('/collaborators/')) return json({ permission: route.includes('/visitor/') ? 'read' : 'write' });
      if (route === '/members/all/3') return json({ access_level: 30 });
      if (route === (gitlab ? '/merge_requests' : '/pulls')) return paginated([pull]);
      if (route === (gitlab ? '/merge_requests/1' : '/pulls/1')) return json(pull);
      if (route.startsWith('/compare/')) return json({ merge_base_commit: { sha: base } });
      if (route.endsWith('/status')) return json({ statuses: statuses.map(status => ({ ...status, context: status.context })).slice(-1) });
      if (route === `/commits/${head}`) return json({ parents: [{ sha: base }] });
      if (route === `/repository/commits/${head}/statuses`) return paginated(statuses.map((s, i) => ({ ...s, status: s.state, id: i + 1 })));
      if (route === `/statuses/${head}`) { statuses.push(body); return json(body, 201); }
      if (route === '/merge_requests/1/pipelines' || route === '/events' || route.endsWith('/resource_state_events')) return paginated([]);
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
          return paginated([...groups].map(([id, notes]) => ({ id, individual_note: false, notes })));
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
    const now = new Date().toISOString(), id = surface.length + 1;
    const row = { id, body, created_at: now, updated_at: now, user: { login: author, type: 'User' }, author: { username: author, name: author },
      issue_url: `${origin}/repos/owner/repo/issues/1`, pull_request_url: `${origin}/repos/owner/repo/pulls/1`,
      html_url: `${origin}/owner/repo/pull/1#comment-${id}`, in_reply_to_id: parent, discussion_id: discussion };
    surface.push(row);
    return row;
  };
  const env = { ...process.env, HEYBOT_HOME: join(dir, 'profile'), GITHUB_TOKEN: safeToken, GITLAB_TOKEN: safeToken };
  const cli = async (...args) => execFile(command[0], [...command.slice(1), ...args], { env, timeout: 25000 });
  return { cli, dir, origin, general, review, statuses, requests, modelCalls,
    open: () => { updated = new Date().toISOString(); state = gitlab ? 'opened' : 'open'; },
    close: () => { updated = new Date().toISOString(); state = 'closed'; },
    merge: () => { updated = merged = new Date().toISOString(); state = gitlab ? 'merged' : 'closed'; },
    oldMerge: () => { state = gitlab ? 'merged' : 'closed'; merged = updated; },
    note: (body, author) => add(general, body, null, author),
    reply: (root, body) => add(review, body, root.id, 'owner', root.discussion_id),
    loseWrite: () => { lost = true; }, rateLimit: () => { limited = true; } };
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
  assert.equal(first.stderr, '');
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
  await runFlow(t, 'github', process.env.HEYBOT_PACKED_BIN ? [process.env.HEYBOT_PACKED_BIN] : undefined);
});
