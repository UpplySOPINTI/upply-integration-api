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
    if (!connection.refreshToken) {
      throw new Error('Bullhorn access expired and no refresh token is available. Reconnect Bullhorn.');
    }

    let refreshed;
    try {
      refreshed = await refreshBullhornAccessToken({
        refreshToken: connection.refreshToken,
        oauthUrl: connection.metadata?.oauthUrl,
      });
    } catch (error) {
      const latest = await getBullhornConnectionSecrets();
      const anotherRefreshWon =
        latest?.accessToken &&
        latest.refreshTokenCiphertext !== connection.refreshTokenCiphertext;
      if (!anotherRefreshWon) throw error;

      accessToken = latest.accessToken;
      connection.metadata = latest.metadata;
    }

    if (refreshed) {
      accessToken = refreshed.access_token;
      const refreshToken = refreshed.refresh_token || connection.refreshToken;

      const updated = await updateBullhornTokens({
        accessToken,
        refreshToken,
        expiresAt: refreshed.expires_at,
        expectedRefreshTokenCiphertext: connection.refreshTokenCiphertext,
      });

      if (!updated) {
        const latest = await getBullhornConnectionSecrets();
        if (!latest?.accessToken) {
          throw new Error('Bullhorn token refresh was superseded but no current token is available.');
        }
        accessToken = latest.accessToken;
        connection.metadata = latest.metadata;
      }
    }
  }

  return loginToBullhornRest({
    accessToken,
    restBase: connection.metadata?.restBaseUrl,
  });
}
