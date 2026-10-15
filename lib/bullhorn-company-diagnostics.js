// Fixed, read-only probes. Never expose upstream bodies or session credentials.
const PROBES = Object.freeze([
  { name: 'companyEntitlements', path: 'entitlements/ClientCorporation', kind: 'entitlements' },
  { name: 'knownCompany', path: 'entity/ClientCorporation/2399', kind: 'record', params: { fields: 'id,name' } },
  { name: 'companyQuery', path: 'query/ClientCorporation', kind: 'list', params: { fields: 'id,name', where: 'id>0', count: '5', start: '0', orderBy: 'id' } },
  { name: 'knownCompanyQuery', path: 'query/ClientCorporation', kind: 'list', params: { fields: 'id,name', where: 'id=2399', count: '1', start: '0' } },
  { name: 'contactCompanyReference', path: 'query/ClientContact', kind: 'contact', params: { fields: 'id,clientCorporation(id,name)', where: 'isDeleted=false', count: '1', start: '0', orderBy: 'id' } },
]);

function cleanText(value, session) {
  let text = String(value ?? '');
  for (const secret of [session.BhRestToken, session.accessToken, session.refreshToken]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:BhRestToken|access_token|refresh_token|client_secret)=)[^&\s"<>]+/gi, '$1[redacted]')
    .slice(0, 400);
}

function companySummary(record, session) {
  if (!record || !Number.isSafeInteger(record.id)) return null;
  return { id: record.id, name: cleanText(record.name, session).slice(0, 200) };
}

async function runProbe(probe, session, fetchImpl) {
  const url = new URL(probe.path, session.restUrl.endsWith('/') ? session.restUrl : `${session.restUrl}/`);
  for (const [key, value] of Object.entries(probe.params || {})) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', BhRestToken: session.BhRestToken },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { name: probe.name, httpStatus: null, httpOk: false, validShape: false, error: 'Upstream request failed, timed out, or redirected.' };
  }
  let body;
  try { body = await response.json(); } catch {
    return { name: probe.name, httpStatus: response.status, httpOk: response.ok, validShape: false, error: 'Upstream response was not JSON.' };
  }
  const errorValue = body?.errorMessage || body?.error || (body?.errorCode != null ? `Bullhorn error code ${body.errorCode}` : null);
  const result = { name: probe.name, httpStatus: response.status, httpOk: response.ok, applicationError: Boolean(errorValue) };
  if (errorValue) result.error = cleanText(typeof errorValue === 'string' ? errorValue : 'Bullhorn returned an error object.', session);
  if (!response.ok && !errorValue) result.error = `Bullhorn returned HTTP ${response.status}.`;
  if (probe.kind === 'entitlements') {
    const values = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    result.validShape = Boolean(values && values.every(value => typeof value === 'string'));
    result.entitlements = (values || []).filter(value => /^(CREATE|READ|UPDATE|DELETE)(_[A-Z]+)*$/.test(value));
  } else if (probe.kind === 'record') {
    const record = companySummary(body?.data ?? body, session);
    result.validShape = Boolean(record);
    result.records = record ? [record] : [];
  } else {
    result.validShape = Array.isArray(body?.data);
    result.returnedCount = result.validShape ? body.data.length : null;
    const records = result.validShape ? body.data.slice(0, 5) : [];
    result.records = records.map(record => companySummary(probe.kind === 'contact' ? record.clientCorporation : record, session)).filter(Boolean);
    if (Number.isSafeInteger(body?.total)) result.total = body.total;
  }
  return result;
}

export async function diagnoseBullhornCompanies({ session, fetchImpl = fetch }) {
  const base = new URL(session.restUrl);
  if (base.protocol !== 'https:' || !/^rest(?:\d+|-[a-z]+)?\.bullhornstaffing\.com$/.test(base.hostname) || !session.BhRestToken || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid Bullhorn REST session.');
  }
  const results = [];
  for (const probe of PROBES) results.push(await runProbe(probe, session, fetchImpl));
  const successful = result => result.httpOk && !result.applicationError && result.validShape;
  const direct = results.find(result => result.name === 'knownCompany');
  const query = results.find(result => result.name === 'companyQuery');
  const entitlements = results.find(result => result.name === 'companyEntitlements');
  return {
    ok: results.every(successful),
    readOnly: true,
    checkedAt: new Date().toISOString(),
    restHost: base.host,
    knownCompanyId: 2399,
    findings: {
      corporateReadEntitlement: successful(entitlements) ? entitlements.entitlements.includes('READ_CORPORATE') : null,
      knownCompanyVisible: successful(direct) && direct.records.some(record => record.id === 2399),
      companyQueryReturnedRecords: successful(query) && query.records.length > 0,
      directRecordVisibleButQueryEmpty: successful(direct) && successful(query) && query.returnedCount === 0,
      requiresInvestigation: !successful(query) || query.returnedCount === 0,
    },
    results,
  };
}
