import { createOauthState } from '../../../../lib/integration-store.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const clientId = process.env.BULLHORN_CLIENT_ID;
    const username = process.env.BULLHORN_USERNAME;
    const password = process.env.BULLHORN_PASSWORD;
    const redirectUri = process.env.BULLHORN_REDIRECT_URI;

    if (!clientId || !username || !password || !redirectUri) {
      return Response.json(
        {
          ok: false,
          error: 'Bullhorn OAuth is not configured yet.',
          missing: {
            clientId: !clientId,
            username: !username,
            password: !password,
            redirectUri: !redirectUri,
          },
        },
        { status: 503 }
      );
    }

    const loginInfoUrl = new URL('https://rest.bullhornstaffing.com/rest-services/loginInfo');
    loginInfoUrl.searchParams.set('username', username);

    const loginInfoResponse = await fetch(loginInfoUrl, {
      method: 'GET',
      cache: 'no-store',
    });

    if (!loginInfoResponse.ok) {
      return Response.json(
        {
          ok: false,
          stage: 'loginInfo',
          status: loginInfoResponse.status,
          error: 'Unable to resolve Bullhorn OAuth host.',
        },
        { status: 502 }
      );
    }

    const loginInfo = await loginInfoResponse.json();
    if (!loginInfo.oauthUrl) {
      return Response.json(
        {
          ok: false,
          stage: 'loginInfo',
          error: 'Bullhorn loginInfo did not return an oauthUrl.',
        },
        { status: 502 }
      );
    }

    const state = globalThis.crypto.randomUUID();
    await createOauthState({
      provider: 'bullhorn',
      state,
      metadata: {
        redirectUri,
      },
    });
    const authorizeUrl = new URL(`${String(loginInfo.oauthUrl).replace(/\/$/, '')}/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('action', 'Login');
    authorizeUrl.searchParams.set('username', username);
    authorizeUrl.searchParams.set('password', password);

    // Keep the dedicated API user's credentials server-side. Bullhorn returns the
    // callback location with the authorization code; only that safe location is
    // forwarded to the browser.
    const authorizeResponse = await fetch(authorizeUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
    });
    const location = authorizeResponse.headers.get('location');

    if (!location) {
      return Response.json(
        {
          ok: false,
          stage: 'authorize',
          status: authorizeResponse.status,
          error: 'Bullhorn authorization did not return an OAuth callback.',
          hint: 'Confirm that the dedicated API user has accepted the Bullhorn terms once.',
        },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const callbackUrl = new URL(location, redirectUri);
    const expectedCallback = new URL(redirectUri);
    const returnedState = callbackUrl.searchParams.get('state');
    const code = callbackUrl.searchParams.get('code');
    const oauthError = callbackUrl.searchParams.get('error');

    if (
      callbackUrl.origin !== expectedCallback.origin ||
      callbackUrl.pathname !== expectedCallback.pathname ||
      returnedState !== state ||
      (!code && !oauthError)
    ) {
      return Response.json(
        {
          ok: false,
          stage: 'authorize',
          error: 'Bullhorn returned an invalid OAuth callback.',
        },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: callbackUrl.toString(),
        'Cache-Control': 'no-store',
        'Set-Cookie': `__Host-bh_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  } catch (error) {
    console.error('Bullhorn connect failed', error);
    return Response.json(
      {
        ok: false,
        stage: 'exception',
        error: error instanceof Error ? error.message : 'Unknown Bullhorn connect error.',
      },
      { status: 500 }
    );
  }
}
