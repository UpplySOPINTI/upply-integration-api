const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export class TypeSafeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Validate the complete response before allowing any score to affect a queue.
export function validateAnswers(data, questions) {
  if (!data || typeof data.model !== 'string' || !data.answers) throw new TypeSafeError('invalid_response');
  for (const [id, question] of Object.entries(questions)) {
    const answer = data.answers[id];
    if (!answer || answer.type !== question.type) throw new TypeSafeError('invalid_response');
    const keys = question.type === 'score'
      ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria);
    const probabilities = answer.probabilities;
    if (!probabilities || Object.keys(probabilities).length !== keys.length ||
        !keys.every(key => Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1) ||
        Math.abs(keys.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.01 ||
        !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
      throw new TypeSafeError('invalid_response');
    }
    if (question.type === 'score') {
      const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
      if (!answer.legend || !keys.every(key => typeof answer.legend[key] === 'string') ||
          !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 ||
          Math.abs(answer.score - expected) > 0.02) throw new TypeSafeError('invalid_response');
    } else if (!keys.includes(answer.choice) ||
        probabilities[answer.choice] < Math.max(...Object.values(probabilities))) {
      throw new TypeSafeError('invalid_response');
    }
  }
  return data;
}

export async function evaluateTypeSafe({ state, questions, fetchImpl = fetch }) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new TypeSafeError('not_configured');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions, model: process.env.TYPESAFE_MODEL || 'jev-latest' }),
    signal: AbortSignal.timeout(25000),
    cache: 'no-store',
  });
  // Do not log provider response bodies: they may echo source data.
  if (!response.ok) throw new TypeSafeError(`provider_${response.status}`);
  return validateAnswers(await response.json(), questions);
}
