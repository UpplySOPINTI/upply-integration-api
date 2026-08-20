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

function jsonWithClearedState(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
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
  const cookieState = cookieValue(request, '__Host-bh_oauth_state');

  if (oauthError) {
    return jsonWithClearedState(
      {
        ok: false,
        stage: 'authorize',
        error: oauthError,
        description: oauthErrorDescription || null,
      },
      { status: 400 }
    );
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return jsonWithClearedState(
      { ok: false, stage: 'state', error: 'Invalid or missing OAuth state.' },
      { status: 400 }
    );
  }

  try {
    const storedState = await consumeOauthState({ provider: 'bullhorn', state });
    if (!storedState) {
      return jsonWithClearedState(
        { ok: false, stage: 'state', error: 'OAuth state is expired or was already used.' },
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
      },
    });

    return jsonWithClearedState({
      ok: true,
      status: 'connected',
      provider: 'bullhorn',
      restHost: new URL(restSession.restUrl).host,
      refreshTokenAvailable: Boolean(tokenData.refresh_token),
      accessTokenExpiresAt: tokenData.expires_at,
    });
  } catch (error) {
    console.error('Bullhorn OAuth callback failed', error);
    return jsonWithClearedState(
      {
        ok: false,
        stage: 'callback',
        error: 'Bullhorn authorization could not be completed.',
      },
      { status: 502 }
    );
  }
}
