import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeAuthorizationCode } from '../lib/bullhorn-oauth.js';
import { GET as connectBullhorn } from '../app/api/bullhorn/connect/route.js';
import {
  queryBullhornEntityPage,
  readBullhornEntity,
} from '../lib/bullhorn-client.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createOauthState } from '../lib/integration-store.js';
import { saveBullhornEntitySnapshots } from '../lib/bullhorn-sync.js';
import {
  internalAccessFailure,
  isInternalRequestAuthorized,
} from '../lib/internal-auth.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of [
    'INTEGRATION_ADMIN_KEY',
    'BULLHORN_CLIENT_ID',
    'BULLHORN_CLIENT_SECRET',
    'BULLHORN_USERNAME',
    'BULLHORN_PASSWORD',
    'BULLHORN_REDIRECT_URI',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    delete process.env[key];
  }
});

test('protects internal integration routes with a bearer secret', async () => {
  process.env.INTEGRATION_ADMIN_KEY = 'internal-test-secret';

  const authorized = new Request('https://example.test/internal', {
    headers: { Authorization: 'Bearer internal-test-secret' },
  });
  const unauthorized = new Request('https://example.test/internal', {
    headers: { Authorization: 'Bearer wrong-secret' },
  });

  assert.equal(isInternalRequestAuthorized(authorized), true);
  assert.equal(isInternalRequestAuthorized(unauthorized), false);
  assert.equal(internalAccessFailure(authorized), null);
  assert.equal(internalAccessFailure(unauthorized).status, 401);
});

test('keeps internal routes closed when no admin secret is configured', () => {
  const request = new Request('https://example.test/internal');
  assert.equal(internalAccessFailure(request).status, 503);
});

test('encrypts integration tokens with authenticated encryption', () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64);
  const plaintext = 'sensitive-token';
  const ciphertext = encrypt(plaintext);

  assert.notEqual(ciphertext, plaintext);
  assert.equal(ciphertext.split('.').length, 3);
  assert.equal(decrypt(ciphertext), plaintext);
});

test('stores only a hash of OAuth state', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, { status: 201 });
  };

  await createOauthState({ provider: 'bullhorn', state: 'raw-state-value' });
  const body = JSON.parse(request.init.body);

  assert.equal(body.provider, 'bullhorn');
  assert.equal(body.state_hash.length, 64);
  assert.equal(JSON.stringify(body).includes('raw-state-value'), false);
  assert.equal(request.init.headers.Authorization, 'Bearer server-secret');
});

test('uses discovered Bullhorn cluster and configured redirect URI for code exchange', async () => {
  process.env.BULLHORN_USERNAME = 'upplyjobs.api';
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  process.env.BULLHORN_CLIENT_SECRET = 'client-secret';
  process.env.BULLHORN_REDIRECT_URI =
    'https://upply-integration-api.vercel.app/api/bullhorn/oauth/callback';

  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('loginInfo')) {
      return Response.json({
        oauthUrl: 'https://auth-ger.bullhornstaffing.com/oauth',
        restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services',
        dataCenterId: 7,
      });
    }
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 600 });
  };

  const token = await exchangeAuthorizationCode({ code: 'authorization-code' });
  const tokenUrl = new URL(requests[1].url);

  assert.equal(token.access_token, 'access');
  assert.equal(token.loginInfo.dataCenterId, 7);
  assert.equal(tokenUrl.host, 'auth-ger.bullhornstaffing.com');
  assert.equal(tokenUrl.searchParams.get('code'), 'authorization-code');
  assert.equal(
    tokenUrl.searchParams.get('redirect_uri'),
    'https://upply-integration-api.vercel.app/api/bullhorn/oauth/callback'
  );
});

test('starts Bullhorn OAuth in the browser with persisted state and no credentials', async () => {
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  process.env.BULLHORN_USERNAME = 'upplyjobs.api';
  process.env.BULLHORN_REDIRECT_URI =
    'https://upply-integration-api.vercel.app/api/bullhorn/oauth/callback';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';

  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith('/loginInfo')) {
      return Response.json({ oauthUrl: 'https://auth-ger.bullhornstaffing.com/oauth' });
    }
    if (parsed.host === 'example.supabase.co') {
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${parsed}`);
  };

  const response = await connectBullhorn();
  const location = new URL(response.headers.get('location'));
  const state = location.searchParams.get('state');

  assert.equal(response.status, 302);
  assert.equal(location.origin, 'https://auth-ger.bullhornstaffing.com');
  assert.equal(location.pathname, '/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('redirect_uri'), process.env.BULLHORN_REDIRECT_URI);
  assert.ok(state);
  assert.equal(location.searchParams.has('action'), false);
  assert.equal(location.searchParams.has('username'), false);
  assert.equal(location.searchParams.has('password'), false);
  assert.match(response.headers.get('set-cookie'), new RegExp(`__Host-bh_oauth_state=${state}`));
  assert.equal(requests.length, 2);
});

test('reads only allowlisted Bullhorn fields and sends the REST token as a header', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ data: [{ id: 42 }], count: 1, start: 0 });
  };

  const page = await queryBullhornEntityPage({
    entity: 'ClientCorporation',
    session: {
      restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services/corp-token/',
      BhRestToken: 'rest-session-secret',
    },
    count: 1,
  });
  const url = new URL(request.url);

  assert.equal(page.data[0].id, 42);
  assert.equal(url.pathname.endsWith('/query/ClientCorporation'), true);
  assert.equal(url.searchParams.get('fields').includes('*'), false);
  assert.equal(url.searchParams.get('where'), 'isDeleted=false');
  assert.equal(request.init.headers.BhRestToken, 'rest-session-secret');
  assert.equal(url.searchParams.has('BhRestToken'), false);
});

test('paginates Bullhorn reads until the final partial page', async () => {
  const starts = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get('start'));
    starts.push(start);
    const data = start === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
    return Response.json({ data, count: data.length, start });
  };

  const records = await readBullhornEntity({
    entity: 'Task',
    session: {
      restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services/corp-token/',
      BhRestToken: 'rest-session-secret',
    },
    pageSize: 2,
  });

  assert.deepEqual(starts, [0, 2]);
  assert.deepEqual(records.map((record) => record.id), [1, 2, 3]);
});

test('rejects non-allowlisted Bullhorn entities before making a request', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ data: [] });
  };

  await assert.rejects(
    queryBullhornEntityPage({
      entity: 'Placement',
      session: { restUrl: 'https://example.test/', BhRestToken: 'secret' },
    }),
    /not allowlisted/
  );
  assert.equal(called, false);
});

test('upserts inbound Bullhorn snapshots with an idempotent external key', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, { status: 201 });
  };

  const persisted = await saveBullhornEntitySnapshots({
    entity: 'ClientCorporation',
    records: [
      {
        id: 28203,
        name: 'Upply test account',
        status: 'Active',
        dateLastModified: 1787224000000,
        isDeleted: false,
      },
    ],
    syncedAt: new Date('2026-08-20T12:00:00.000Z'),
  });
  const url = new URL(request.url);
  const body = JSON.parse(request.init.body);

  assert.equal(persisted, 1);
  assert.equal(url.pathname, '/rest/v1/crm_sync');
  assert.equal(url.searchParams.get('on_conflict'), 'system,entity_type,external_id');
  assert.equal(body[0].system, 'bullhorn');
  assert.equal(body[0].entity_type, 'ClientCorporation');
  assert.equal(body[0].external_id, '28203');
  assert.equal(body[0].metadata.source, 'live_rest');
  assert.equal(body[0].metadata.payload.name, 'Upply test account');
  assert.equal(request.init.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
});
