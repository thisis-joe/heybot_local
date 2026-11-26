import test from 'node:test';
import assert from 'node:assert/strict';
import { CsInterviewBatchSchema, AnswerKeySchema } from '../dist/contracts.js';
import { initialQuestions as plainQuestions, checked } from './fixtures.mjs';
const initialQuestions = () => plainQuestions().map(checked);

test('interview output requires a shortfall reason, at most two questions and complete four-choice keys', () => {
  for (const count of [0, 1, 2, 3]) {
    const questions = Array.from({ length: count }, () => initialQuestions()[0]);
    assert.equal(CsInterviewBatchSchema.safeParse({ questions, unavailableReason: '근거 제한' }).success, count < 2);
    assert.equal(CsInterviewBatchSchema.safeParse({ questions, unavailableReason: null }).success, count === 2);
    assert.equal(CsInterviewBatchSchema.safeParse({ questions }).success, false);
  }
  const q = initialQuestions()[0];
  for (const bad of [{ ...q, options: q.options.slice(0, 3) }, { ...q, key: undefined }, { ...q, key: { ...q.key, answer: 'E' } }]) {
    assert.equal(CsInterviewBatchSchema.safeParse({ questions: [bad], unavailableReason: '제한' }).success, false);
  }
  assert.equal(CsInterviewBatchSchema.safeParse({ questions: [], unavailableReason: ' ' }).success, false);
});

test('interview keys may teach in up to five sentences while option notes and other keys stay at three', () => {
  const q = initialQuestions()[0], sentences = n => Array.from({ length: n }, (_, i) => `문장 ${i + 1}입니다.`).join(' ');
  const batch = key => ({ questions: [{ ...q, key: { ...q.key, ...key } }], unavailableReason: '한 문항만 출제했습니다.' });
  assert.equal(CsInterviewBatchSchema.safeParse(batch({ explanation: sentences(5) })).success, true);
  assert.equal(CsInterviewBatchSchema.safeParse(batch({ explanation: sentences(6) })).success, false);
  assert.equal(CsInterviewBatchSchema.safeParse(batch({ options: q.key.options.map((o, i) => i ? o : { ...o, explanation: sentences(4) }) })).success, false);
  assert.equal(AnswerKeySchema.safeParse({ ...q.key, explanation: sentences(4) }).success, false);
});

