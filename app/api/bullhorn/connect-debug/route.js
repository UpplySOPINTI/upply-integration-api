export async function GET() {
  try {
    const clientId = process.env.BULLHORN_CLIENT_ID;
    const username = process.env.BULLHORN_USERNAME;
    const redirectUri = process.env.BULLHORN_REDIRECT_URI;

    if (!clientId || !username || !redirectUri) {
      return Response.json(
        {
          ok: false,
          stage: 'config',
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
        },
        { status: 502 }
      );
    }

    const loginInfo = await loginInfoResponse.json();
    const oauthBase = loginInfo.oauthUrl;

    if (!oauthBase) {
      return Response.json(
        {
          ok: false,
          stage: 'loginInfo',
          error: 'Bullhorn loginInfo did not return oauthUrl.',
        },
        { status: 502 }
      );
    }

    const authorizeUrl = new URL(`${oauthBase.replace(/\/$/, '')}/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);

    return Response.json({
      ok: true,
      stage: 'ready',
      oauthHost: authorizeUrl.origin,
      redirectUri,
      authorizeUrl: authorizeUrl.toString(),
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        stage: 'exception',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
