import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeAuthorizationCode } from '../lib/bullhorn-oauth.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createOauthState } from '../lib/integration-store.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
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
