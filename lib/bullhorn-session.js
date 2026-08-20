import { loginToBullhornRest, refreshBullhornAccessToken } from './bullhorn-oauth.js';
import {
  getBullhornConnectionSecrets,
  updateBullhornTokens,
} from './integration-store.js';

const REFRESH_SKEW_MS = 60 * 1000;

function needsRefresh(expiresAt) {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + REFRESH_SKEW_MS;
}

export async function getBullhornRestSession() {
  const connection = await getBullhornConnectionSecrets();
  if (!connection || connection.status !== 'connected') {
    throw new Error('Bullhorn is not connected.');
  }

  let accessToken = connection.accessToken;
  if (!accessToken) throw new Error('Bullhorn access token is unavailable.');

  if (needsRefresh(connection.access_token_expires_at)) {
    const refreshed = await refreshBullhornAccessToken({
      refreshToken: connection.refreshToken,
      oauthUrl: connection.metadata?.oauthUrl,
    });
    accessToken = refreshed.access_token;
    const refreshToken = refreshed.refresh_token || connection.refreshToken;

    await updateBullhornTokens({
      accessToken,
      refreshToken,
      expiresAt: refreshed.expires_at,
    });
  }

  return loginToBullhornRest({
    accessToken,
    restBase: connection.metadata?.restBaseUrl,
  });
}
