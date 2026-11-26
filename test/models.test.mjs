import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { checkClaudeModel, createModel } from '../dist/models.js';
import { initialQuestions } from './fixtures.mjs';

const grade = {
  verdict: 'correct', explanation: '변경된 로직이 빈 값을 건너뜁니다.', expectedAnswer: '빈 값을 제외한 뒤 결과를 사용합니다.',
  optionExplanations: ['A', 'B', 'C', 'D'].map(id => ({ id, explanation: `${id} 보기 해설입니다.` })),
  evidence: [{ path: 'labels.ts', line: 2, side: 'RIGHT', reason: '값을 필터링합니다.' }],
};

async function endpoint(t, handle) {
  const server = createServer(async (req, res) => {
    try {
      const contents = [];
      for await (const chunk of req) contents.push(chunk);
      const { status = 200, value } = await handle(req, contents.length ? JSON.parse(Buffer.concat(contents)) : null);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    } catch (error) { t.diagnostic(error.stack); res.writeHead(500).end(); }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('Claude model diagnosis uses the read-only Models API and authenticates the configured key', async t => {
  const keyEnv = 'HEYBOT_FIXTURE_DOCTOR_CLAUDE_KEY';
  process.env[keyEnv] = 'model-fixture-secret';
  t.after(() => delete process.env[keyEnv]);
  let status = 200;
  const url = await endpoint(t, (req, body) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models/chosen-claude-model');
    assert.equal(req.headers['x-api-key'], process.env[keyEnv]);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(body, null);
    return { status, value: status === 200 ? { type: 'model', id: 'resolved-model' } : { message: process.env[keyEnv] } };
  });
  const config = { provider: 'claude', model: 'chosen-claude-model', keyEnv };
  await checkClaudeModel(config, `${url}/v1`);
  status = 401;
  await assert.rejects(checkClaudeModel(config, `${url}/v1`), {
    failure: { provider: 'claude', code: 'authentication', apiStatus: 401 },
  });
});

test('Claude API key is scoped to Messages, grammar uses its supported subset and Zod checks complete output', async t => {
  const keyEnv = 'HEYBOT_FIXTURE_CLAUDE_KEY';
  process.env[keyEnv] = 'only-the-model-fixture';
  t.after(() => delete process.env[keyEnv]);
  let invalid = false;
  const url = await endpoint(t, (req, body) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], process.env[keyEnv]);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers['private-token'], undefined);
    assert.equal(body.model, 'chosen-claude-model');
    assert.equal(body.tools, undefined);
    const schema = body.output_config.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.match(schema.properties.questions.description, /minItems=2/);
    assert.equal(schema.properties.questions.maxItems, undefined);
    const questions = initialQuestions();
    return { value: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ questions: invalid ? questions.slice(0, 1) : questions }) }] } };
  });
  const model = createModel({ provider: 'claude', model: 'chosen-claude-model', keyEnv }, `${url}/v1/messages`);
  assert.equal((await model.run('initial_questions', '합성 자료입니다.', 'fixture')).questions.length, 2);
  invalid = true;
  await assert.rejects(model.run('initial_questions', '합성 자료입니다.', 'fixture'), { failure: { provider: 'claude', code: 'invalid_output' } });
});

test('Ollama uses the requested local model and grade schema and reports provider failures without a fallback', async t => {
  let writes = 0, rateLimited = false;
  const url = await endpoint(t, (req, body) => {
    if (req.url === '/api/tags') return { value: { models: [{ name: 'model-q:local', digest: 'a'.repeat(64), size: 50 }] } };
    assert.equal(req.url, '/api/chat');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-api-key'], undefined);
    writes++;
    assert.equal(body.model, 'model-q:local');
    assert.equal(body.options.num_ctx, 8192);
    assert.ok(body.format.properties.verdict);
    assert.equal(body.tools, undefined);
    return rateLimited ? { status: 429, value: {} } : { value: { done: true, message: { content: JSON.stringify(grade) } } };
  });
  const model = createModel({ provider: 'ollama', model: 'model-q:local', context: 8192, url });
  assert.deepEqual(await model.run('grade', '합성 답변을 채점합니다.', 'fixture'), grade);
  rateLimited = true;
  await assert.rejects(model.run('grade', '합성 답변을 채점합니다.', 'fixture'), { failure: { provider: 'ollama', code: 'rate_limit', apiStatus: 429 } });
  const missing = createModel({ provider: 'ollama', model: 'missing', context: 8192, url });
  await assert.rejects(missing.run('grade', '합성 자료입니다.', 'fixture'), { failure: { provider: 'ollama', code: 'model_unavailable' } });
  assert.equal(writes, 2);
});
