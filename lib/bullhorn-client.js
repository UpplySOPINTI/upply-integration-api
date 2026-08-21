import { getBullhornRestSession } from './bullhorn-session.js';

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_ACTIVE_FILTER = 'isDeleted=false';
const SEARCH_ACTIVE_FILTER = 'isDeleted:0';

// Bullhorn does not support JPQL /query for Candidate or Note. This tenant also
// does not expose isDeleted as a JPQL field on ClientCorporation. All three have
// an official Lucene /search endpoint, so keep their adapter choice explicit.
const BULLHORN_SEARCH_ENTITIES = new Set(['Candidate', 'ClientCorporation', 'Note']);

export const BULLHORN_READ_ENTITIES = Object.freeze({
  ClientCorporation: Object.freeze([
    'id',
    'name',
    'status',
    'companyURL',
    'address',
    'phone',
    'dateAdded',
    'dateLastModified',
    'isDeleted',
    'owner',
  ]),
  ClientContact: Object.freeze([
    'id',
    'firstName',
    'lastName',
    'name',
    'status',
    'occupation',
    'email',
    'phone',
    'mobile',
    'clientCorporation',
    'address',
    'massMailOptOut',
    'dateAdded',
    'dateLastModified',
    'isDeleted',
    'owner',
  ]),
  Candidate: Object.freeze([
    'id',
    'firstName',
    'lastName',
    'name',
    'status',
    'occupation',
    'address',
    'employmentPreference',
    'experience',
    'dateAdded',
    'dateLastModified',
    'isDeleted',
    'owner',
  ]),
  JobOrder: Object.freeze([
    'id',
    'title',
    'status',
    'clientCorporation',
    'clientContact',
    'address',
    'employmentType',
    'isOpen',
    'isDeleted',
    'dateAdded',
    'dateLastModified',
    'startDate',
    'numOpenings',
    'skillList',
    'yearsRequired',
    'owner',
  ]),
  Opportunity: Object.freeze([
    'id',
    'title',
    'status',
    'clientCorporation',
    'clientContact',
    'address',
    'dateAdded',
    'dateLastModified',
    'isDeleted',
    'owner',
  ]),
  Note: Object.freeze([
    'id',
    'action',
    'dateAdded',
    'dateLastModified',
    'isDeleted',
    'comments',
    'personReference',
    'jobOrder',
    'commentingPerson',
  ]),
  Task: Object.freeze([
    'id',
    'subject',
    'description',
    'type',
    'priority',
    'dateBegin',
    'dateEnd',
    'dateCompleted',
    'dateAdded',
    'dateLastModified',
    'isCompleted',
    'isDeleted',
    'isPrivate',
    'candidate',
    'clientContact',
    'jobOrder',
    'opportunity',
    'owner',
  ]),
});

function entityFields(entity) {
  const fields = BULLHORN_READ_ENTITIES[entity];
  if (!fields) throw new Error(`Bullhorn entity is not allowlisted: ${entity}`);
  return fields;
}

function selectedEntityFields(entity, requestedFields) {
  const allowedFields = entityFields(entity);
  if (!requestedFields) return allowedFields;
  if (!Array.isArray(requestedFields) || requestedFields.length === 0) {
    throw new Error(`Bullhorn ${entity} fields must be a non-empty array.`);
  }

  const invalidField = requestedFields.find((field) => !allowedFields.includes(field));
  if (invalidField) {
    throw new Error(`Bullhorn ${entity} field is not allowlisted: ${invalidField}`);
  }
  return [...new Set(requestedFields)];
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function responseJson(response, entity) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = body?.errorMessage || body?.error || `HTTP ${response.status}`;
    throw new Error(`Bullhorn ${entity} read failed: ${detail}`);
  }

  return body || {};
}

export async function queryBullhornEntityPage({
  entity,
  session,
  fields,
  start = 0,
  count = DEFAULT_PAGE_SIZE,
  where = DEFAULT_ACTIVE_FILTER,
  orderBy = 'id',
}) {
  const activeSession = session || (await getBullhornRestSession());
  const pageSize = boundedInteger(count, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = boundedInteger(start, 0, 0, Number.MAX_SAFE_INTEGER);
  const requestedFields = selectedEntityFields(entity, fields);
  const operation = BULLHORN_SEARCH_ENTITIES.has(entity) ? 'search' : 'query';

  if (operation === 'search' && where !== DEFAULT_ACTIVE_FILTER) {
    throw new Error(
      `Bullhorn ${entity} requires a Lucene search filter; custom JPQL filters are not supported.`
    );
  }

  const requestPage = (currentSession) => {
    const endpoint = new URL(
      `${operation}/${entity}`,
      String(currentSession.restUrl).endsWith('/')
        ? currentSession.restUrl
        : `${currentSession.restUrl}/`
    );
    endpoint.searchParams.set('fields', requestedFields.join(','));
    if (operation === 'search') {
      endpoint.searchParams.set('query', SEARCH_ACTIVE_FILTER);
      endpoint.searchParams.set('sort', orderBy);
    } else {
      endpoint.searchParams.set('where', where);
      endpoint.searchParams.set('orderBy', orderBy);
    }
    endpoint.searchParams.set('count', String(pageSize));
    endpoint.searchParams.set('start', String(offset));

    return fetch(endpoint, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        BhRestToken: currentSession.BhRestToken,
      },
    });
  };

  let response = await requestPage(activeSession);
  let restSessionRecreated = false;
  if (response.status === 401) {
    const recreatedSession = await getBullhornRestSession();
    Object.assign(activeSession, recreatedSession);
    response = await requestPage(activeSession);
    restSessionRecreated = true;
  }
  const body = await responseJson(response, entity);
  const data = Array.isArray(body.data) ? body.data : [];

  return {
    data,
    count: Number.isInteger(body.count) ? body.count : data.length,
    start: Number.isInteger(body.start) ? body.start : offset,
    httpStatus: response.status,
    restSessionRecreated,
    operation,
  };
}

export async function readBullhornEntity({
  entity,
  pageSize = DEFAULT_PAGE_SIZE,
  maxRecords = DEFAULT_MAX_RECORDS,
  where = DEFAULT_ACTIVE_FILTER,
  session,
}) {
  const activeSession = session || (await getBullhornRestSession());
  const boundedPageSize = boundedInteger(pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const boundedMaxRecords = boundedInteger(maxRecords, DEFAULT_MAX_RECORDS, 1, 25000);
  const records = [];

  while (records.length < boundedMaxRecords) {
    const count = Math.min(boundedPageSize, boundedMaxRecords - records.length);
    const page = await queryBullhornEntityPage({
      entity,
      session: activeSession,
      start: records.length,
      count,
      where,
    });
    records.push(...page.data);
    if (page.data.length < count) break;
  }

  return records;
}

export async function probeBullhornReadScope() {
  const session = await getBullhornRestSession();
  const results = [];

  for (const entity of Object.keys(BULLHORN_READ_ENTITIES)) {
    try {
      const page = await queryBullhornEntityPage({ entity, session, count: 1 });
      results.push({
        entity,
        accessible: true,
        sampleCount: page.data.length,
        operation: page.operation,
      });
    } catch (error) {
      results.push({
        entity,
        accessible: false,
        error: error instanceof Error ? error.message : 'Unknown read error',
      });
    }
  }

  return {
    ok: results.every((result) => result.accessible),
    restHost: new URL(session.restUrl).host,
    session: session.diagnostics,
    entities: results,
  };
}
