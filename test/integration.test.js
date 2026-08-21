import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeAuthorizationCode } from '../lib/bullhorn-oauth.js';
import { GET as connectBullhorn } from '../app/api/bullhorn/connect/route.js';
import { GET as callbackBullhorn } from '../app/api/bullhorn/oauth/callback/route.js';
import {
  queryBullhornEntityPage,
  readBullhornEntity,
} from '../lib/bullhorn-client.js';
import { getBullhornRestSession } from '../lib/bullhorn-session.js';
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
    'INTEGRATION_ENCRYPTION_KEY',
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

test('starts Bullhorn OAuth without provider state and keeps a one-time browser nonce', async () => {
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
  const setCookie = response.headers.get('set-cookie');
  const nonce = setCookie.match(/__Host-bh_oauth_nonce=([^;]+)/)?.[1];

  assert.equal(response.status, 302);
  assert.equal(location.origin, 'https://auth-ger.bullhornstaffing.com');
  assert.equal(location.pathname, '/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('redirect_uri'), process.env.BULLHORN_REDIRECT_URI);
  assert.equal(location.searchParams.has('state'), false);
  assert.ok(nonce);
  assert.equal(location.searchParams.has('action'), false);
  assert.equal(location.searchParams.has('username'), false);
  assert.equal(location.searchParams.has('password'), false);
  assert.match(setCookie, new RegExp(`__Host-bh_oauth_nonce=${nonce}`));
  assert.equal(requests.length, 2);
});

test('completes the Bullhorn callback with a valid one-time nonce and matching client', async () => {
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  process.env.BULLHORN_CLIENT_SECRET = 'client-secret';
  process.env.BULLHORN_USERNAME = 'upplyjobs.api';
  process.env.BULLHORN_REDIRECT_URI =
    'https://upply-integration-api.vercel.app/api/bullhorn/oauth/callback';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  process.env.INTEGRATION_ENCRYPTION_KEY = 'b'.repeat(64);

  const nonce = 'one-time-browser-nonce';
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, init });

    if (parsed.host === 'example.supabase.co' && parsed.pathname.endsWith('/oauth_states')) {
      return Response.json([{ id: 1, metadata: { oauthMode: 'cookie_nonce_without_provider_state' } }]);
    }
    if (parsed.pathname.endsWith('/loginInfo')) {
      return Response.json({
        oauthUrl: 'https://auth-ger.bullhornstaffing.com/oauth',
        restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services',
        dataCenterId: 7,
      });
    }
    if (parsed.pathname.endsWith('/token')) {
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 600 });
    }
    if (parsed.pathname.endsWith('/login')) {
      return Response.json({
        BhRestToken: 'rest-token',
        restUrl: 'https://rest7.bullhornstaffing.com/rest-services/corp-token/',
      });
    }
    if (
      parsed.host === 'example.supabase.co' &&
      parsed.pathname.endsWith('/integration_connections')
    ) {
      return Response.json([{ provider: 'bullhorn', status: 'connected' }]);
    }
    throw new Error(`Unexpected fetch: ${parsed}`);
  };

  const response = await callbackBullhorn(
    new Request(
      `${process.env.BULLHORN_REDIRECT_URI}?code=authorization-code&client_id=client-id`,
      { headers: { Cookie: `__Host-bh_oauth_nonce=${nonce}` } }
    )
  );
  const body = await response.json();
  const consumeRequest = requests.find(({ url }) => url.pathname.endsWith('/oauth_states'));
  const savedConnection = requests.find(({ url }) =>
    url.pathname.endsWith('/integration_connections')
  );

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'connected');
  assert.equal(consumeRequest.init.method, 'PATCH');
  assert.match(consumeRequest.url.searchParams.get('state_hash'), /^eq\.[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(consumeRequest).includes(nonce), false);
  assert.equal(
    JSON.parse(savedConnection.init.body).metadata.oauthMode,
    'cookie_nonce_without_provider_state'
  );
  assert.match(response.headers.get('set-cookie'), /__Host-bh_oauth_nonce=;/);
});

test('rejects a stateless Bullhorn callback without the one-time browser nonce', async () => {
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('Callback must fail before an external request.');
  };

  const response = await callbackBullhorn(
    new Request('https://example.test/api/bullhorn/oauth/callback?code=code&client_id=client-id')
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.stage, 'session');
  assert.equal(called, false);
});

test('rejects a stateless Bullhorn callback for a different client id', async () => {
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('Callback must fail before an external request.');
  };

  const response = await callbackBullhorn(
    new Request('https://example.test/api/bullhorn/oauth/callback?code=code&client_id=other', {
      headers: { Cookie: '__Host-bh_oauth_nonce=nonce' },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.stage, 'client');
  assert.equal(called, false);
});

test('reads only allowlisted Bullhorn fields and sends the REST token as a header', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ data: [{ id: 42 }], count: 1, start: 0 });
  };

  const page = await queryBullhornEntityPage({
    entity: 'JobOrder',
    session: {
      restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services/corp-token/',
      BhRestToken: 'rest-session-secret',
    },
    count: 1,
  });
  const url = new URL(request.url);

  assert.equal(page.data[0].id, 42);
  assert.equal(url.pathname.endsWith('/query/JobOrder'), true);
  assert.equal(url.searchParams.get('fields').includes('*'), false);
  assert.equal(url.searchParams.get('where'), 'isDeleted=false');
  assert.equal(request.init.headers.BhRestToken, 'rest-session-secret');
  assert.equal(url.searchParams.has('BhRestToken'), false);
});

test('limits a Bullhorn probe to an allowlisted field subset', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return Response.json({ data: [{ id: 42, name: 'Example' }], count: 1, start: 0 });
  };

  await queryBullhornEntityPage({
    entity: 'ClientCorporation',
    fields: ['id', 'name'],
    session: {
      restUrl: 'https://rest-ger.bullhornstaffing.com/rest-services/corp-token/',
      BhRestToken: 'rest-session-secret',
    },
    count: 5,
  });

  assert.equal(requestedUrl.searchParams.get('fields'), 'id,name');
  assert.equal(requestedUrl.pathname.endsWith('/search/ClientCorporation'), true);
  assert.equal(requestedUrl.searchParams.get('query'), 'isDeleted:0');
  assert.equal(requestedUrl.searchParams.get('sort'), 'id');
  assert.equal(requestedUrl.searchParams.has('where'), false);
});

test('refreshes an expired OAuth token and creates a new Bullhorn REST session', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  process.env.INTEGRATION_ENCRYPTION_KEY = 'c'.repeat(64);
  process.env.BULLHORN_CLIENT_ID = 'client-id';
  process.env.BULLHORN_CLIENT_SECRET = 'client-secret';

  const storedRefreshCiphertext = encrypt('stored-refresh-token');
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ parsed, init });

    if (parsed.host === 'example.supabase.co' && init.method !== 'PATCH') {
      return Response.json([
        {
          provider: 'bullhorn',
          status: 'connected',
          token_ciphertext: encrypt('expired-access-token'),
          refresh_token_ciphertext: storedRefreshCiphertext,
          access_token_expires_at: '2026-08-20T00:00:00.000Z',
          rest_url: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
          metadata: {
            oauthUrl: 'https://auth-ger.bullhornstaffing.com/oauth',
            restBaseUrl: 'https://rest-ger.bullhornstaffing.com/rest-services',
          },
        },
      ]);
    }
    if (parsed.pathname.endsWith('/token')) {
      return Response.json({
        access_token: 'refreshed-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 600,
      });
    }
    if (parsed.host === 'example.supabase.co' && init.method === 'PATCH') {
      return Response.json([{ provider: 'bullhorn', status: 'connected' }]);
    }
    if (parsed.pathname.endsWith('/login')) {
      return Response.json({
        BhRestToken: 'new-rest-session-token',
        restUrl: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
      });
    }
    throw new Error(`Unexpected fetch: ${parsed}`);
  };

  const session = await getBullhornRestSession();
  const refreshRequest = requests.find(({ parsed }) => parsed.pathname.endsWith('/token'));
  const loginRequest = requests.find(({ parsed }) => parsed.pathname.endsWith('/login'));

  assert.equal(session.diagnostics.accessTokenRefreshed, true);
  assert.equal(session.diagnostics.restSessionCreated, true);
  assert.equal(refreshRequest.parsed.searchParams.get('grant_type'), 'refresh_token');
  assert.equal(loginRequest.parsed.searchParams.get('access_token'), 'refreshed-access-token');
  assert.equal(JSON.stringify(session.diagnostics).includes('token'), false);
  const sessionStoreRequest = requests.find(({ parsed, init }) => {
    if (parsed.host !== 'example.supabase.co' || init.method !== 'PATCH' || !init.body) return false;
    return Object.hasOwn(JSON.parse(init.body), 'rest_token_ciphertext');
  });
  const storedSessionBody = JSON.parse(sessionStoreRequest.init.body);
  assert.notEqual(storedSessionBody.rest_token_ciphertext, 'new-rest-session-token');
  assert.equal(JSON.stringify(storedSessionBody).includes('new-rest-session-token'), false);
});

test('reuses an encrypted Bullhorn REST session without logging in again', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  process.env.INTEGRATION_ENCRYPTION_KEY = 'e'.repeat(64);

  let bullhornCalled = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.host !== 'example.supabase.co') {
      bullhornCalled = true;
      throw new Error(`Unexpected Bullhorn request: ${parsed}`);
    }
    return Response.json([
      {
        provider: 'bullhorn',
        status: 'connected',
        token_ciphertext: encrypt('current-access-token'),
        refresh_token_ciphertext: encrypt('current-refresh-token'),
        rest_token_ciphertext: encrypt('stored-rest-session'),
        access_token_expires_at: '2099-01-01T00:00:00.000Z',
        rest_url: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
        metadata: { restBaseUrl: 'https://rest-ger.bullhornstaffing.com/rest-services' },
      },
    ]);
  };

  const session = await getBullhornRestSession();

  assert.equal(session.BhRestToken, 'stored-rest-session');
  assert.equal(session.diagnostics.restSessionCreated, false);
  assert.equal(session.diagnostics.restSessionReused, true);
  assert.equal(bullhornCalled, false);
});

test('recreates the Bullhorn REST session once after a 401 response', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
  process.env.INTEGRATION_ENCRYPTION_KEY = 'd'.repeat(64);

  let entityAttempts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search/ClientCorporation')) {
      entityAttempts += 1;
      if (entityAttempts === 1) {
        return Response.json({ errorMessage: 'Session expired' }, { status: 401 });
      }
      assert.equal(init.headers.BhRestToken, 'replacement-rest-session');
      return Response.json({ data: [{ id: 7, name: 'Recovered' }], count: 1, start: 0 });
    }
    if (parsed.host === 'example.supabase.co') {
      return Response.json([
        {
          provider: 'bullhorn',
          status: 'connected',
          token_ciphertext: encrypt('current-access-token'),
          refresh_token_ciphertext: encrypt('current-refresh-token'),
          access_token_expires_at: '2099-01-01T00:00:00.000Z',
          rest_url: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
          metadata: { restBaseUrl: 'https://rest-ger.bullhornstaffing.com/rest-services' },
        },
      ]);
    }
    if (parsed.pathname.endsWith('/login')) {
      return Response.json({
        BhRestToken: 'replacement-rest-session',
        restUrl: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
      });
    }
    throw new Error(`Unexpected fetch: ${parsed}`);
  };

  const originalSession = {
    restUrl: 'https://rest70.bullhornstaffing.com/rest-services/corp-token/',
    BhRestToken: 'expired-rest-session',
  };
  const page = await queryBullhornEntityPage({
    entity: 'ClientCorporation',
    fields: ['id', 'name'],
    session: originalSession,
    count: 5,
  });

  assert.equal(entityAttempts, 2);
  assert.equal(page.httpStatus, 200);
  assert.equal(page.restSessionRecreated, true);
  assert.equal(originalSession.BhRestToken, 'replacement-rest-session');
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
