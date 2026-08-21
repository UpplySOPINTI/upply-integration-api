import { loginToBullhornRest, refreshBullhornAccessToken } from './bullhorn-oauth.js';
import {
  getBullhornConnectionSecrets,
  updateBullhornTokens,
} from './integration-store.js';

const REFRESH_SKEW_MS = 60 * 1000;

export class BullhornSessionError extends Error {
  constructor(stage, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BullhornSessionError';
    this.stage = stage;
  }
}

function sessionError(stage, message, cause) {
  return cause instanceof BullhornSessionError
    ? cause
    : new BullhornSessionError(stage, message, cause);
}

export function describeBullhornSessionError(error) {
  const causeMessage = error?.cause instanceof Error ? error.cause.message : null;
  return {
    stage: error instanceof BullhornSessionError ? error.stage : 'unknown',
    error: error instanceof Error ? error.message : 'Bullhorn session failed.',
    ...(causeMessage ? { cause: causeMessage } : {}),
  };
}

function needsRefresh(expiresAt) {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + REFRESH_SKEW_MS;
}

export async function getBullhornRestSession() {
  let connection;
  try {
    connection = await getBullhornConnectionSecrets();
  } catch (error) {
    throw sessionError(
      'connection_load',
      'The stored Bullhorn connection could not be loaded.',
      error
    );
  }

  if (!connection || connection.status !== 'connected') {
    throw sessionError('connection_load', 'Bullhorn is not connected.');
  }

  let accessToken = connection.accessToken;
  if (!accessToken) {
    throw sessionError('connection_load', 'Bullhorn access token is unavailable.');
  }

  let accessTokenRefreshed = false;

  if (needsRefresh(connection.access_token_expires_at)) {
    if (!connection.refreshToken) {
      throw sessionError(
        'token_refresh',
        'Bullhorn access expired and no refresh token is available. Reconnect Bullhorn.'
      );
    }

    let refreshed;
    try {
      refreshed = await refreshBullhornAccessToken({
        refreshToken: connection.refreshToken,
        oauthUrl: connection.metadata?.oauthUrl,
      });
    } catch (error) {
      let latest;
      try {
        latest = await getBullhornConnectionSecrets();
      } catch {
        throw sessionError('token_refresh', 'Bullhorn access token refresh failed.', error);
      }
      const anotherRefreshWon =
        latest?.accessToken &&
        latest.refreshTokenCiphertext !== connection.refreshTokenCiphertext;
      if (!anotherRefreshWon) {
        throw sessionError('token_refresh', 'Bullhorn access token refresh failed.', error);
      }

      accessToken = latest.accessToken;
      connection.metadata = latest.metadata;
      accessTokenRefreshed = true;
    }

    if (refreshed) {
      accessToken = refreshed.access_token;
      const refreshToken = refreshed.refresh_token || connection.refreshToken;

      let updated;
      try {
        updated = await updateBullhornTokens({
          accessToken,
          refreshToken,
          expiresAt: refreshed.expires_at,
          expectedRefreshTokenCiphertext: connection.refreshTokenCiphertext,
        });
      } catch (error) {
        throw sessionError('token_store', 'Refreshed Bullhorn tokens could not be stored.', error);
      }

      if (!updated) {
        let latest;
        try {
          latest = await getBullhornConnectionSecrets();
        } catch (error) {
          throw sessionError(
            'token_store',
            'The current Bullhorn token could not be reloaded.',
            error
          );
        }
        if (!latest?.accessToken) {
          throw sessionError(
            'token_store',
            'Bullhorn token refresh was superseded but no current token is available.'
          );
        }
        accessToken = latest.accessToken;
        connection.metadata = latest.metadata;
      }
      accessTokenRefreshed = true;
    }
  }

  try {
    const session = await loginToBullhornRest({
      accessToken,
      restBase: connection.metadata?.restBaseUrl,
    });
    return {
      ...session,
      diagnostics: {
        accessTokenPresent: true,
        refreshTokenPresent: Boolean(connection.refreshToken),
        accessTokenRefreshed,
        restSessionCreated: true,
      },
    };
  } catch (error) {
    throw sessionError('rest_login', 'Bullhorn REST session creation failed.', error);
  }
}
