import { internalAccessFailure } from '../../../../lib/internal-auth.js';
import { getBullhornRestSession } from '../../../../lib/bullhorn-session.js';
import { diagnoseBullhornCompanies } from '../../../../lib/bullhorn-company-diagnostics.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const accessFailure = internalAccessFailure(request);
  if (accessFailure) return accessFailure;
  try {
    const session = await getBullhornRestSession();
    const result = await diagnoseBullhornCompanies({ session });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Session errors can contain provider URLs or credentials. Do not echo them.
    return Response.json({ ok: false, readOnly: true, error: 'Company diagnostics could not obtain a valid Bullhorn session.' }, {
      status: 502, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
