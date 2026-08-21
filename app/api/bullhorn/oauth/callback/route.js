import { exchangeAuthorizationCode, loginToBullhornRest } from '../../../../../lib/bullhorn-oauth.js';
import { consumeOauthState, saveBullhornConnection } from '../../../../../lib/integration-store.js';

export const dynamic = 'force-dynamic';

function cookieValue(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function jsonWithClearedOauthCookies(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.append(
    'Set-Cookie',
    '__Host-bh_oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );
  headers.append(
    'Set-Cookie',
    '__Host-bh_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );

  return Response.json(body, { ...init, headers });
}

export async function GET(request) {
  const url = new URL(request.url);
  const oauthError = url.searchParams.get('error');
  const oauthErrorDescription = url.searchParams.get('error_description');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const returnedClientId = url.searchParams.get('client_id');
  const cookieNonce = cookieValue(request, '__Host-bh_oauth_nonce');
  const expectedClientId = process.env.BULLHORN_CLIENT_ID;

  if (oauthError) {
    return jsonWithClearedOauthCookies(
      {
        ok: false,
        stage: 'authorize',
        error: oauthError,
        description: oauthErrorDescription || null,
      },
      { status: 400 }
    );
  }

  if (!code || !cookieNonce) {
    return jsonWithClearedOauthCookies(
      { ok: false, stage: 'session', error: 'Invalid or missing OAuth browser session.' },
      { status: 400 }
    );
  }

  // Prefer standard state validation if Bullhorn starts echoing it again. The
  // current GER fallback binds the callback to our one-time browser nonce and
  // additionally requires Bullhorn's returned client_id to match exactly.
  if (state && state !== cookieNonce) {
    return jsonWithClearedOauthCookies(
      { ok: false, stage: 'state', error: 'Invalid OAuth state.' },
      { status: 400 }
    );
  }

  if (!state && (!expectedClientId || returnedClientId !== expectedClientId)) {
    return jsonWithClearedOauthCookies(
      { ok: false, stage: 'client', error: 'Invalid or missing OAuth client.' },
      { status: 400 }
    );
  }

  try {
    const storedState = await consumeOauthState({ provider: 'bullhorn', state: cookieNonce });
    if (!storedState) {
      return jsonWithClearedOauthCookies(
        { ok: false, stage: 'session', error: 'OAuth session is expired or was already used.' },
        { status: 400 }
      );
    }

    const tokenData = await exchangeAuthorizationCode({ code });
    const restSession = await loginToBullhornRest({ accessToken: tokenData.access_token });

    await saveBullhornConnection({
      tokenData,
      restSession,
      metadata: {
        dataCenterId: tokenData.loginInfo.dataCenterId ?? null,
        superClusterId: tokenData.loginInfo.superClusterId ?? null,
        oauthUrl: tokenData.loginInfo.oauthUrl,
        restBaseUrl: tokenData.loginInfo.restUrl,
        oauthMode: state ? 'provider_state' : 'cookie_nonce_without_provider_state',
      },
    });

    return jsonWithClearedOauthCookies({
      ok: true,
      status: 'connected',
      provider: 'bullhorn',
      restHost: new URL(restSession.restUrl).host,
      refreshTokenAvailable: Boolean(tokenData.refresh_token),
      accessTokenExpiresAt: tokenData.expires_at,
    });
  } catch (error) {
    console.error('Bullhorn OAuth callback failed', error);
    return jsonWithClearedOauthCookies(
      {
        ok: false,
        stage: 'callback',
        error: 'Bullhorn authorization could not be completed.',
      },
      { status: 502 }
    );
  }
}
