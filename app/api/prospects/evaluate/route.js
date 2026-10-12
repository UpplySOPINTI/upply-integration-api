import { internalAccessFailure } from '../../../../lib/internal-auth.js';
import { evaluateProspect, ProspectInputError } from '../../../../lib/prospect-evaluation.js';
import { TypeSafeError } from '../../../../lib/typesafe-client.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  const denied = internalAccessFailure(request);
  if (denied) return denied;
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (Number(request.headers.get('content-length')) > 150000) throw new ProspectInputError('Request too large.');
    const body = await request.text();
    if (Buffer.byteLength(body) > 150000) throw new ProspectInputError('Request too large.');
    let input;
    try { input = JSON.parse(body); } catch { throw new ProspectInputError('Invalid JSON.'); }
    return Response.json(await evaluateProspect(input), { headers });
  } catch (error) {
    if (error instanceof ProspectInputError) return Response.json({ ok: false, error: error.message }, { status: 400, headers });
    if (error instanceof TypeSafeError && error.code === 'not_configured') {
      return Response.json({ ok: false, error: 'TypeSafe is not configured.' }, { status: 503, headers });
    }
    return Response.json({ ok: false, error: 'Prospect evaluation unavailable; no scores applied.' }, { status: 502, headers });
  }
}
