import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseBullhornCompanies } from '../lib/bullhorn-company-diagnostics.js';
import { GET } from '../app/api/bullhorn/company-diagnostics/route.js';

const session = { restUrl: 'https://rest72.bullhornstaffing.com/rest-services/example/', BhRestToken: 'private-session-token' };

function fixture({ queryBody = { data: [] }, directStatus = 200, entitlements = ['READ_CORPORATE'], invalidJSON = false } = {}) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); requests.push({ url, init });
    if (invalidJSON) return new Response('<html>private-session-token</html>');
    if (url.pathname.includes('/entitlements/')) return Response.json(entitlements);
    if (url.pathname.includes('/entity/')) return Response.json(directStatus === 200 ? { data: { id: 2399, name: 'NSI' } } : { errorMessage: 'Record not visible' }, { status: directStatus });
    if (url.pathname.endsWith('/ClientContact')) return Response.json({ data: [{ id: 1, name: 'Do not disclose contact', email: 'private@example.test', clientCorporation: { id: 2399, name: 'NSI' } }] });
    return Response.json(queryBody);
  };
  return { requests, fetchImpl };
}

test('compares direct company lookup to query and reads actual entitlements', async () => {
  const { requests, fetchImpl } = fixture();
  const result = await diagnoseBullhornCompanies({ session, fetchImpl });
  assert.equal(result.findings.corporateReadEntitlement, true);
  assert.equal(result.findings.directRecordVisibleButQueryEmpty, true);
  assert.equal(result.findings.requiresInvestigation, true);
  assert.equal(requests.length, 5);
  assert.ok(requests.every(request => request.init.method === 'GET' && request.init.redirect === 'error'));
  assert.ok(requests.every(request => request.init.headers.BhRestToken === session.BhRestToken));
  assert.equal(requests[2].url.searchParams.get('where'), 'id>0');
  assert.equal(requests[3].url.searchParams.get('where'), 'id=2399');
  assert.equal(JSON.stringify(result).includes(session.BhRestToken), false);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.equal(JSON.stringify(result).includes('Do not disclose contact'), false);
});

test('does not interpret an HTTP 200 error object as empty company data', async () => {
  const { fetchImpl } = fixture({ queryBody: { errorMessage: 'Denied private-session-token Bearer hidden-value', errorCode: 403 } });
  const result = await diagnoseBullhornCompanies({ session, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.results[2].applicationError, true);
  assert.equal(result.results[2].validShape, false);
  assert.equal(result.findings.directRecordVisibleButQueryEmpty, false);
  assert.equal(JSON.stringify(result).includes('private-session-token'), false);
  assert.equal(JSON.stringify(result).includes('hidden-value'), false);
});

test('recognizes records returned by the query without inventing an access problem', async () => {
  const { fetchImpl } = fixture({ queryBody: { data: [{ id: 2399, name: 'NSI', secret: 'not-returned' }], total: 1 } });
  const result = await diagnoseBullhornCompanies({ session, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.findings.companyQueryReturnedRecords, true);
  assert.equal(result.findings.requiresInvestigation, false);
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
});

test('reports limited entitlements without claiming the company is absent', async () => {
  const { fetchImpl } = fixture({ directStatus: 404, entitlements: ['READ'] });
  const result = await diagnoseBullhornCompanies({ session, fetchImpl });
  assert.equal(result.findings.corporateReadEntitlement, false);
  assert.equal(result.findings.knownCompanyVisible, false);
  assert.equal(result.findings.requiresInvestigation, true);
  assert.equal(result.ok, false);
});

test('handles malformed JSON, unexpected shapes, and network failure safely', async () => {
  const malformed = await diagnoseBullhornCompanies({ session, fetchImpl: fixture({ invalidJSON: true }).fetchImpl });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.results.every(result => result.validShape === false));
  const badShape = await diagnoseBullhornCompanies({ session, fetchImpl: fixture({ queryBody: { count: 0 } }).fetchImpl });
  assert.equal(badShape.results[2].validShape, false);
  const failed = await diagnoseBullhornCompanies({ session, fetchImpl: async () => { throw new Error('private-session-token'); } });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes(session.BhRestToken), false);
});

test('rejects unexpected upstream hosts and does not perform requests', async () => {
  let fetched = false;
  await assert.rejects(diagnoseBullhornCompanies({ session: { ...session, restUrl: 'https://example.test/' }, fetchImpl: async () => { fetched = true; } }));
  assert.equal(fetched, false);
});

test('route rejects missing or incorrect admin credentials before session access', async () => {
  const old = process.env.INTEGRATION_ADMIN_KEY;
  try {
    process.env.INTEGRATION_ADMIN_KEY = 'unit-test-admin';
    const response = await GET(new Request('https://example.test/api/bullhorn/company-diagnostics'));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: 'Unauthorized.' });
    assert.equal((await GET(new Request('https://example.test/api/bullhorn/company-diagnostics', {
      headers: { Authorization: 'Bearer wrong-key' },
    }))).status, 401);
    delete process.env.INTEGRATION_ADMIN_KEY;
    assert.equal((await GET(new Request('https://example.test/api/bullhorn/company-diagnostics'))).status, 503);
  } finally {
    if (old === undefined) delete process.env.INTEGRATION_ADMIN_KEY;
    else process.env.INTEGRATION_ADMIN_KEY = old;
  }
});
