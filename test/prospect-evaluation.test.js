import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProspect, prepareProspect } from '../lib/prospect-evaluation.js';
import { evaluateTypeSafe, validateAnswers } from '../lib/typesafe-client.js';
import { POST } from '../app/api/prospects/evaluate/route.js';

const now = new Date('2026-10-12T16:00:00Z');
function fixture() {
  return {
    company: { id: 'test-company', name: 'Synthetic Infrastructure BV', employeeCount: 50,
      relationship: 'Cold prospect', relationshipCheckedAt: now.toISOString(),
      evidence: [{ id: 'website', text: 'An infrastructure MSP with repeat systems hiring.', url: 'https://example.test/about', checkedAt: now.toISOString() }] },
    jobs: [{ id: 'job-1', title: 'System Engineer', description: 'Manage Windows Server, AD and VMware.',
      url: 'https://example.test/jobs/1', status: 'open', checkedAt: now.toISOString() }],
    candidates: [{ id: 'anonymous-pair-1', jobId: 'job-1', profile: 'Five years Windows Server, AD and VMware.',
      checkedAt: now.toISOString(), checks: { commute: 'pass', salary: 'pass', languages: 'pass', availability: 'pass', employmentType: 'pass' } }],
  };
}
function provider({ questions }) {
  const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === 'score') return [key, { type: 'score', score: 4, confidence: 1,
      legend: Object.fromEntries(question.criteria.map((level, i) => [i, level])),
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } }];
    const choice = key.startsWith('job_') ? 'system' : key.startsWith('match_') ? 'strong' : 'known';
    return [key, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, Number(option === choice)])) }];
  }));
  return validateAnswers({ model: 'synthetic-test-model', answers, usage: { input_tokens: 0, output_tokens: 0 } }, questions);
}
const run = input => evaluateProspect({ ...input, mode: 'evaluate' }, { now, evaluate: async plan => provider(plan) });

test('preview makes no paid request and writes nothing', async () => {
  const result = await evaluateProspect(fixture(), { now, evaluate: () => { throw Error('Must not call'); } });
  assert.equal(result.mode, 'preview');
  assert.equal(result.persistence, 'none');
});
test('keeps 40/30/20/10 score and provides traceable vacancy reasons', async () => {
  const result = await run(fixture());
  assert.equal(result.total, 100);
  assert.deepEqual(Object.values(result.dimensions).map(d => d.maximum), [40, 30, 20, 10]);
  assert.equal(result.queue, 'call');
  assert.equal(result.matches[0].disposition, 'shortlist_for_review');
  assert.equal(result.reasons[0].sourceUrl, 'https://example.test/jobs/1');
});
test('known relationships and unknown CRM state cannot enter cold queue', async () => {
  for (const relationship of ['Klant', 'Warme relatie', 'Niet benaderen', 'Ex-klant', 'Actieve opportunity', 'Partner/recruitment bureau', 'unknown']) {
    const input = fixture(); input.company.relationship = relationship;
    assert.equal((await run(input)).queue, 'relationship_review');
  }
});
test('stale or future-dated evidence and jobs produce research, not invented scores', async () => {
  for (const date of ['2025-01-01', '2027-01-01', 'not-a-date']) {
    const input = fixture(); input.company.evidence[0].checkedAt = date; input.jobs[0].checkedAt = date;
    const result = await run(input);
    assert.equal(result.total, null);
    assert.equal(result.queue, 'research');
    assert.equal(result.matches[0].disposition, 'review');
  }
});
test('candidate hard failures cannot be outweighed by AI fit; unknown remains review', async () => {
  const input = fixture(); input.candidates[0].checks.salary = 'fail';
  assert.equal((await run(input)).matches[0].disposition, 'blocked');
  input.candidates[0].checks.salary = 'unknown';
  assert.equal((await run(input)).matches[0].disposition, 'review');
});
test('contact priority follows size; unknown employee count requires verification', async () => {
  const input = fixture();
  assert.equal((await run(input)).contactPriority, 'director_or_c_level');
  input.company.employeeCount = 300;
  assert.equal((await run(input)).contactPriority, 'hiring_manager_or_team_lead');
  delete input.company.employeeCount;
  assert.equal((await run(input)).contactPriority, 'verify_company_size');
});
test('missing dimensions stay null and low confidence sends prospect to research', async () => {
  const input = fixture();
  const result = await evaluateProspect({ ...input, mode: 'evaluate' }, { now, evaluate: async plan => {
    const result = provider(plan); result.answers.icp.confidence = 0.3; return result;
  } });
  assert.equal(result.dimensions.icp.points, null);
  assert.equal(result.total, null);
  assert.equal(result.queue, 'research');
});
test('drops raw CRM fields and contact identity before provider request', () => {
  const input = fixture(); input.rawBullhorn = { email: 'secret@example.test' };
  input.candidates[0].email = 'secret@example.test'; input.candidates[0].name = 'Private Name';
  const { state } = prepareProspect(input, now);
  assert.equal(JSON.stringify(state).includes('secret@example.test'), false);
  assert.equal(JSON.stringify(state).includes('Private Name'), false);
});
test('rejects duplicate IDs and incomplete hard checks', () => {
  const input = fixture(); input.jobs.push({ ...input.jobs[0] });
  assert.throws(() => prepareProspect(input, now), /Duplicate/);
  const other = fixture(); delete other.candidates[0].checks;
  assert.throws(() => prepareProspect(other, now), /hard checks/);
});
test('rejects malformed distributions, out of range and missing provider answers', () => {
  const plan = prepareProspect(fixture(), now);
  for (const mutate of [result => delete result.answers.icp,
    result => result.answers.icp.probabilities[4] = -1,
    result => result.answers.icp.score = 10,
    result => result.answers.icp_known.choice = 'invented']) {
    const result = provider(plan); mutate(result);
    assert.throws(() => validateAnswers(result, plan.questions), /invalid_response/);
  }
});
test('uses documented API shape and fails safely on rate limits', async () => {
  process.env.TYPESAFE_API_KEY = 'synthetic-key';
  try {
    const plan = prepareProspect(fixture(), now);
    await evaluateTypeSafe({ ...plan, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(init.body); assert.equal(body.model, 'jev-latest');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
      return Response.json(provider(plan));
    } });
    await assert.rejects(evaluateTypeSafe({ ...plan, fetchImpl: async () => new Response('private details', { status: 429 }) }), /provider_429/);
  } finally { delete process.env.TYPESAFE_API_KEY; }
});
test('API requires internal authentication and returns a clear missing-key response', async () => {
  process.env.INTEGRATION_ADMIN_KEY = 'synthetic-admin';
  try {
    assert.equal((await POST(new Request('https://example.test/evaluate', { method: 'POST' }))).status, 401);
    const input = fixture();
    input.company.evidence[0].checkedAt = new Date().toISOString();
    const response = await POST(new Request('https://example.test/evaluate', { method: 'POST',
      headers: { Authorization: 'Bearer synthetic-admin' }, body: JSON.stringify({ ...input, mode: 'evaluate' }) }));
    assert.equal(response.status, 503);
  } finally { delete process.env.INTEGRATION_ADMIN_KEY; }
});

test('closed or irrelevant jobs do not justify a cold call', async () => {
  const input = fixture(); input.jobs[0].status = 'closed';
  assert.equal((await run(input)).queue, 'research');
  input.jobs[0].status = 'open';
  const result = await evaluateProspect({ ...input, mode: 'evaluate' }, { now, evaluate: async plan => {
    const result = provider(plan);
    result.answers.job_0.choice = 'other';
    for (const key of Object.keys(result.answers.job_0.probabilities)) result.answers.job_0.probabilities[key] = Number(key === 'other');
    return result;
  } });
  assert.equal(result.queue, 'research');
  assert.equal(result.matches[0].disposition, 'review');
});
test('low fit and stale CRM checks cannot become a call recommendation', async () => {
  const input = fixture();
  const result = await evaluateProspect({ ...input, mode: 'evaluate' }, { now, evaluate: async plan => {
    const result = provider(plan);
    for (const answer of Object.values(result.answers)) {
      if (answer.type !== 'score') continue;
      answer.score = 0; answer.probabilities = { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 };
    }
    return result;
  } });
  assert.equal(result.queue, 'low_priority');
  input.company.relationshipCheckedAt = '2025-01-01';
  assert.equal((await run(input)).queue, 'relationship_review');
});
