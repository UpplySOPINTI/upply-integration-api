import { probeBullhornReadScope } from '../../../../lib/bullhorn-client.js';
import { describeBullhornSessionError } from '../../../../lib/bullhorn-session.js';
import { internalAccessFailure } from '../../../../lib/internal-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const accessFailure = internalAccessFailure(request);
  if (accessFailure) return accessFailure;

  try {
    const readiness = await probeBullhornReadScope();
    return Response.json(readiness, {
      status: readiness.ok ? 200 : 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const diagnosis = describeBullhornSessionError(error);
    console.error('Bullhorn read scope probe failed', diagnosis);
    return Response.json(
      {
        ok: false,
        error: 'Bullhorn read scope could not be verified.',
        diagnosis,
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
