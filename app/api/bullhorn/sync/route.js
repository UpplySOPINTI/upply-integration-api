import { syncBullhornReadEntities } from '../../../../lib/bullhorn-sync.js';
import { BULLHORN_READ_ENTITIES } from '../../../../lib/bullhorn-client.js';
import { internalAccessFailure } from '../../../../lib/internal-auth.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export async function POST(request) {
  const accessFailure = internalAccessFailure(request);
  if (accessFailure) return accessFailure;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const entities = Array.isArray(body.entities)
    ? [...new Set(body.entities)]
    : Object.keys(BULLHORN_READ_ENTITIES);
  const apply = body.mode === 'apply';
  const maxRecordsPerEntity = positiveInteger(body.maxRecordsPerEntity, 500, 5000);

  try {
    const result = await syncBullhornReadEntities({
      entities,
      maxRecordsPerEntity,
      apply,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Bullhorn read sync failed', error);
    return Response.json(
      { ok: false, mode: apply ? 'apply' : 'dry-run', error: 'Bullhorn sync failed.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
