import { createOauthState } from '../../../../lib/integration-store.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const clientId = process.env.BULLHORN_CLIENT_ID;
    const username = process.env.BULLHORN_USERNAME;
    const redirectUri = process.env.BULLHORN_REDIRECT_URI;

    if (!clientId || !username || !redirectUri) {
      return Response.json(
        {
          ok: false,
          error: 'Bullhorn OAuth is not configured yet.',
          missing: {
            clientId: !clientId,
            username: !username,
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

    // Bullhorn GER currently crashes when the standard OAuth `state` query
    // parameter is present. Keep an equivalent one-time nonce entirely between
    // our browser and server until Bullhorn resolves the upstream defect.
    const nonce = globalThis.crypto.randomUUID();
    await createOauthState({
      provider: 'bullhorn',
      state: nonce,
      metadata: {
        redirectUri,
        oauthMode: 'cookie_nonce_without_provider_state',
      },
    });
    const authorizeUrl = new URL(`${String(loginInfo.oauthUrl).replace(/\/$/, '')}/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl.toString(),
        'Cache-Control': 'no-store',
        'Set-Cookie': `__Host-bh_oauth_nonce=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
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
