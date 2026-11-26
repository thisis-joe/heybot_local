import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AnswerSchema, InitialQuestionsSchema, InitialQuestionChecksSchema, InitialQuestionRepairsSchema,
  QuestionBatchSchema, CsInterviewBatchSchema, MoreCsBatchSchema, GradeSchema } from './contracts.js';
import { credential, trustedUrl, type ModelConfig } from './config.js';
import { execute } from './process.js';
import { ModelFailure, failureInfo } from './model-failure.js';
import type { Model, ModelPhase } from './review.js';
import { boundedText } from './http-client.js';
import { redact } from './redact.js';

export const phaseSchemas = {
  answer: AnswerSchema, initial_questions: InitialQuestionsSchema,
  verify_initial_questions: InitialQuestionChecksSchema, repair_initial_questions: InitialQuestionRepairsSchema,
  questions: QuestionBatchSchema, csinterview: CsInterviewBatchSchema, morecs: MoreCsBatchSchema, grade: GradeSchema,
} satisfies Record<ModelPhase, z.ZodType>;

function codexEnv(): NodeJS.ProcessEnv {
  const keys = ['PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'CODEX_HOME'];
  return { HOME: homedir(), LANG: 'C.UTF-8', ...Object.fromEntries(keys.map(key => [key, process.env[key]])) };
}
export async function checkCodexLogin(): Promise<void> {
  const status = await execute('codex', ['login', 'status'], { env: codexEnv(), allowFailure: true, captureStderr: true, timeoutMs: 15000 });
  if (status.code !== 0 || !/logged in using chatgpt/i.test(Buffer.concat([status.stdout, status.stderr]).toString('utf8')))
    throw new ModelFailure({ provider: 'codex', code: 'authentication' });
}

const claudeApi = 'https://api.anthropic.com/v1';
type ClaudeConfig = Extract<ModelConfig, { provider: 'claude' }>;
type OllamaConfig = Extract<ModelConfig, { provider: 'ollama' }>;

function claudeHeaders(config: ClaudeConfig): Record<string, string> {
  try { return { 'x-api-key': credential(config.keyEnv), 'anthropic-version': '2023-06-01' }; }
  catch { throw new ModelFailure({ code: 'authentication', provider: 'claude' }); }
}

export async function checkClaudeModel(config: ClaudeConfig, endpoint = claudeApi): Promise<void> {
  if (config.model === '.' || config.model === '..')
    throw new ModelFailure({ code: 'model_unavailable', provider: 'claude' });
  const response = await fetch(`${endpoint}/models/${encodeURIComponent(config.model)}`, {
    headers: claudeHeaders(config), redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelFailure({ provider: 'claude', apiStatus: response.status, code: response.status === 429 ? 'rate_limit'
      : [401, 403].includes(response.status) ? 'authentication' : response.status === 404 ? 'model_unavailable' : 'unavailable' });
  }
  const model = JSON.parse(await boundedText(response, 512000));
  if (model?.type !== 'model' || typeof model.id !== 'string' || !model.id)
    throw new ModelFailure({ code: 'invalid_output', provider: 'claude' });
}

export async function checkOllamaModel(config: OllamaConfig): Promise<string> {
  const url = trustedUrl(config.url, true);
  // Ollama accepts hosted model names as well. Limit this provider to installed local model blobs.
  if (/(?:[-:]cloud)(?:$|:)/i.test(config.model))
    throw new ModelFailure({ code: 'model_unavailable', provider: 'ollama' });
  const tags = await fetch(`${url}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!tags.ok) {
    await tags.body?.cancel();
    throw new ModelFailure({ code: 'unavailable', provider: 'ollama', apiStatus: tags.status });
  }
  const models = JSON.parse(await boundedText(tags, 512000))?.models;
  const name = config.model.split('/').at(-1)?.includes(':') ? config.model : `${config.model}:latest`;
  if (!Array.isArray(models) || !models.some(entry => (entry?.name === name || entry?.model === name)
    && typeof entry.digest === 'string' && /^[a-f0-9]{64}$/i.test(entry.digest) && entry.size > 0 && !entry.remote_host)) {
    throw new ModelFailure({ code: 'model_unavailable', provider: 'ollama' });
  }
  return url;
}

function outputSchema(phase: ModelPhase) {
  const { $schema: _meta, ...schema } = z.toJSONSchema(phaseSchemas[phase], { unrepresentable: 'any' });
  return schema;
}

// The Claude grammar supports a subset of JSON Schema. Zod still validates the full response.
function claudeSchema(node: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const constraints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
      'maxItems', 'pattern', 'uniqueItems'].includes(key) || (key === 'minItems' && value > 1)) {
      constraints.push(`${key}=${value}`);
    } else if (['properties', '$defs', 'definitions'].includes(key)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, claudeSchema(schema as Record<string, unknown>)]));
    } else if (['anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key)) {
      result[key] = value.map(claudeSchema);
    } else if (key === 'items' && typeof value === 'object') {
      result[key] = claudeSchema(value);
    } else result[key] = value;
  }
  if (constraints.length) result.description = [node.description, ...constraints].filter(Boolean).join('; ');
  return result;
}

async function codex(config: Extract<ModelConfig, { provider: 'codex' }>, phase: ModelPhase, prompt: string, timeoutMs: number): Promise<unknown> {
  await checkCodexLogin();
  const dir = await mkdtemp(join(tmpdir(), 'heybot-model-'));
  const schema = join(dir, 'schema.json'), output = join(dir, 'answer.json');
  try {
    await writeFile(schema, JSON.stringify(outputSchema(phase)), { mode: 0o600 });
    const result = await execute('codex', [
      'exec', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json',
      ...['shell_tool', 'multi_agent', 'apps', 'hooks', 'browser_use', 'computer_use', 'view_image', 'image_generation'].flatMap(feature => ['--disable', feature]),
      '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0',
      '--output-schema', schema, '-o', output, '-C', dir, ...(config.model ? ['--model', config.model] : []), '-',
    ], { cwd: dir, env: codexEnv(), input: prompt, timeoutMs, maxBytes: 4 * 1024 * 1024, allowFailure: true, captureStderr: true });
    if (result.code !== 0) {
      const events = Buffer.concat([result.stdout, result.stderr]).toString('utf8');
      const code = /rate.limit|usage.limit|\b429\b/i.test(events) ? 'rate_limit'
        : /unauthori[sz]ed|authenticat|\b401\b/i.test(events) ? 'authentication' : /model.*(?:not found|not supported|not available)/i.test(events) ? 'model_unavailable' : 'unavailable';
      throw new ModelFailure({ provider: 'codex', code });
    }
    const bytes = await readFile(output);
    if (bytes.length > 512000) throw new ModelFailure({ provider: 'codex', code: 'invalid_output' });
    return JSON.parse(bytes.toString('utf8'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function httpModel(
  config: Exclude<ModelConfig, { provider: 'codex' }>,
  phase: ModelPhase,
  prompt: string,
  timeoutMs: number,
  claudeEndpoint: string,
): Promise<unknown> {
  const schema = outputSchema(phase);
  const messages = [{ role: 'user', content: prompt }];
  const isClaude = config.provider === 'claude';
  const headers = { 'content-type': 'application/json', ...(isClaude ? claudeHeaders(config) : {}) };
  const endpoint = isClaude ? claudeEndpoint : `${await checkOllamaModel(config)}/api/chat`;
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers,
    body: JSON.stringify(isClaude
      ? { model: config.model, messages, max_tokens: 8192, output_config: { format: { type: 'json_schema', schema: claudeSchema(schema) } } }
      : { model: config.model, messages, stream: false, format: schema, options: { temperature: 0, num_ctx: config.context } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelFailure({ provider: config.provider, apiStatus: response.status, code: response.status === 429 ? 'rate_limit'
      : [401, 403].includes(response.status) ? 'authentication' : response.status === 404 ? 'model_unavailable' : response.status >= 500 ? 'unavailable' : 'invalid_output' });
  }
  const payload = JSON.parse(await boundedText(response, 512000));
  const raw = isClaude
    ? (payload.stop_reason === 'end_turn' ? payload.content?.find((block: { type: string }) => block.type === 'text')?.text : undefined)
    : (payload.done === true && !payload.remote_model && !payload.remote_host ? payload.message?.content : undefined);
  if (typeof raw !== 'string') throw new ModelFailure({ provider: config.provider, code: 'invalid_output' });
  return JSON.parse(raw);
}

function scrubOutput(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrubOutput);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubOutput(item)]));
  return value;
}

export function createModel(config: ModelConfig, claudeEndpoint = `${claudeApi}/messages`): Model {
  return {
    async run(phase, prompt, _id, timeoutMs = 120000) {
      try {
        const input = redact(prompt);
        const output = config.provider === 'codex'
          ? await codex(config, phase, input, timeoutMs)
          : await httpModel(config, phase, input, timeoutMs, claudeEndpoint);
        return phaseSchemas[phase].parse(scrubOutput(output));
      } catch (error) {
        if (error instanceof TypeError) throw new ModelFailure({ provider: config.provider, code: 'unavailable' });
        throw new ModelFailure(failureInfo(error, config.provider));
      }
    },
  };
}
