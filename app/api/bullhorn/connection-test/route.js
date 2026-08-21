import { queryBullhornEntityPage } from '../../../../lib/bullhorn-client.js';
import {
  describeBullhornSessionError,
  getBullhornRestSession,
} from '../../../../lib/bullhorn-session.js';
import { internalAccessFailure } from '../../../../lib/internal-auth.js';

export const dynamic = 'force-dynamic';

const TESTS = Object.freeze([
  Object.freeze({ entity: 'ClientCorporation', fields: ['id', 'name'] }),
  Object.freeze({ entity: 'Candidate', fields: ['id', 'name'] }),
  Object.freeze({ entity: 'JobOrder', fields: ['id', 'title'] }),
]);

export async function GET(request) {
  const accessFailure = internalAccessFailure(request);
  if (accessFailure) return accessFailure;

  let session;
  try {
    session = await getBullhornRestSession();
  } catch (error) {
    const diagnosis = describeBullhornSessionError(error);
    console.error('Bullhorn connection test session failed', diagnosis);
    return Response.json(
      {
        ok: false,
        error: 'Bullhorn REST session could not be created.',
        diagnosis,
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const restHost = new URL(session.restUrl).host;
  const results = [];
  for (const test of TESTS) {
    try {
      const page = await queryBullhornEntityPage({
        ...test,
        session,
        count: 5,
      });
      results.push({
        entity: test.entity,
        fields: test.fields,
        httpStatus: page.httpStatus,
        operation: page.operation,
        restHost,
        restSessionPresent: Boolean(session.BhRestToken),
        restSessionRecreated: page.restSessionRecreated,
        response: {
          count: page.count,
          data: page.data,
        },
      });
    } catch (error) {
      results.push({
        entity: test.entity,
        fields: test.fields,
        restHost,
        restSessionPresent: Boolean(session.BhRestToken),
        error: error instanceof Error ? error.message : 'Unknown Bullhorn read error.',
      });
    }
  }

  const ok = results.every((result) => result.httpStatus === 200);
  return Response.json(
    {
      ok,
      session: session.diagnostics,
      results,
    },
    { status: ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } }
  );
}
