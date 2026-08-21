import crypto from 'crypto';
import { decrypt, encrypt } from './crypto.js';
import { supabaseRest } from './supabase-admin.js';

function hashState(state) {
  return crypto.createHash('sha256').update(state, 'utf8').digest('hex');
}

export async function createOauthState({ provider, state, metadata = {} }) {
  await supabaseRest('oauth_states', {
    method: 'POST',
    body: {
      provider,
      state_hash: hashState(state),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      metadata,
    },
    prefer: 'return=minimal',
  });
}

export async function consumeOauthState({ provider, state }) {
  const rows = await supabaseRest('oauth_states', {
    method: 'PATCH',
    query: {
      provider: `eq.${provider}`,
      state_hash: `eq.${hashState(state)}`,
      consumed_at: 'is.null',
      expires_at: `gt.${new Date().toISOString()}`,
      select: 'id,metadata',
    },
    body: { consumed_at: new Date().toISOString() },
    prefer: 'return=representation',
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function saveBullhornConnection({ tokenData, restSession, metadata = {} }) {
  const currentRefreshToken = tokenData.refresh_token || null;
  const rows = await supabaseRest('integration_connections', {
    method: 'POST',
    query: { on_conflict: 'provider', select: 'provider,status,access_token_expires_at,rest_url,updated_at' },
    body: {
      provider: 'bullhorn',
      status: 'connected',
      account_label: process.env.BULLHORN_USERNAME || null,
      token_ciphertext: encrypt(tokenData.access_token),
      refresh_token_ciphertext: encrypt(currentRefreshToken),
      rest_token_ciphertext: encrypt(restSession.BhRestToken),
      access_token_expires_at: tokenData.expires_at,
      rest_url: restSession.restUrl,
      metadata,
      updated_at: new Date().toISOString(),
    },
    prefer: 'resolution=merge-duplicates,return=representation',
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function getBullhornConnectionSecrets() {
  const rows = await supabaseRest('integration_connections', {
    query: {
      provider: 'eq.bullhorn',
      select:
        'provider,status,token_ciphertext,refresh_token_ciphertext,rest_token_ciphertext,access_token_expires_at,rest_url,metadata',
      limit: '1',
    },
  });
  const row = Array.isArray(rows) ? rows[0] || null : null;
  if (!row) return null;

  return {
    ...row,
    accessToken: decrypt(row.token_ciphertext),
    refreshToken: decrypt(row.refresh_token_ciphertext),
    restToken: decrypt(row.rest_token_ciphertext),
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    restTokenCiphertext: row.rest_token_ciphertext,
    token_ciphertext: undefined,
    refresh_token_ciphertext: undefined,
    rest_token_ciphertext: undefined,
  };
}

export async function updateBullhornRestSession({ restToken, restUrl }) {
  const rows = await supabaseRest('integration_connections', {
    method: 'PATCH',
    query: {
      provider: 'eq.bullhorn',
      select: 'provider,status,rest_url,updated_at',
    },
    body: {
      rest_token_ciphertext: encrypt(restToken),
      rest_url: restUrl,
      updated_at: new Date().toISOString(),
    },
    prefer: 'return=representation',
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function updateBullhornTokens({
  accessToken,
  refreshToken,
  expiresAt,
  expectedRefreshTokenCiphertext,
}) {
  const query = {
    provider: 'eq.bullhorn',
    select: 'provider,status,access_token_expires_at,updated_at',
  };
  if (expectedRefreshTokenCiphertext) {
    query.refresh_token_ciphertext = `eq.${expectedRefreshTokenCiphertext}`;
  }

  const rows = await supabaseRest('integration_connections', {
    method: 'PATCH',
    query,
    body: {
      status: 'connected',
      token_ciphertext: encrypt(accessToken),
      refresh_token_ciphertext: encrypt(refreshToken),
      access_token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    prefer: 'return=representation',
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function getBullhornConnectionSummary() {
  const rows = await supabaseRest('integration_connections', {
    query: {
      provider: 'eq.bullhorn',
      select: 'provider,status,account_label,access_token_expires_at,rest_url,updated_at',
      limit: '1',
    },
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}
