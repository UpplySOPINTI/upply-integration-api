export async function GET() {
  try {
    const clientId = process.env.BULLHORN_CLIENT_ID;
    const username = process.env.BULLHORN_USERNAME;
    const redirectUri = process.env.BULLHORN_REDIRECT_URI;

    if (!clientId || !username || !redirectUri) {
      return Response.json({
        ok: false,
        stage: 'config',
        missing: {
          clientId: !clientId,
          username: !username,
          redirectUri: !redirectUri,
        },
      }, { status: 503 });
    }

    const loginInfoUrl = new URL('https://rest.bullhornstaffing.com/rest-services/loginInfo');
    loginInfoUrl.searchParams.set('username', username);
    const response = await fetch(loginInfoUrl, { cache: 'no-store' });
    if (!response.ok) {
      return Response.json({ ok: false, stage: 'loginInfo', status: response.status }, { status: 502 });
    }

    const loginInfo = await response.json();
    const authorizeUrl = new URL(`${String(loginInfo.oauthUrl).replace(/\/$/, '')}/authorize`);
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
    return Response.json({
      ok: false,
      stage: 'exception',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
