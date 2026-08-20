export const dynamic = 'force-dynamic';

function safeError(stage, response, body) {
  return {
    ok: false,
    stage,
    status: response?.status ?? null,
    error: typeof body === 'string' ? body.slice(0, 500) : body,
  };
}

export async function GET() {
  const clientId = process.env.BULLHORN_CLIENT_ID;
  const clientSecret = process.env.BULLHORN_CLIENT_SECRET;
  const username = process.env.BULLHORN_USERNAME;
  const password = process.env.BULLHORN_PASSWORD;
  const redirectUri = process.env.BULLHORN_REDIRECT_URI;

  const missing = [
    ['BULLHORN_CLIENT_ID', clientId],
    ['BULLHORN_CLIENT_SECRET', clientSecret],
    ['BULLHORN_USERNAME', username],
    ['BULLHORN_PASSWORD', password],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    return Response.json({ ok: false, stage: 'config', missing }, { status: 503 });
  }

  try {
    // 1) Discover the correct Bullhorn data center for this API user.
    const loginInfoUrl = new URL(
      'https://rest.bullhornstaffing.com/rest-services/loginInfo'
    );
    loginInfoUrl.searchParams.set('username', username);

    const loginInfoResponse = await fetch(loginInfoUrl, {
      cache: 'no-store',
      redirect: 'follow',
    });
    const loginInfoText = await loginInfoResponse.text();

    if (!loginInfoResponse.ok) {
      return Response.json(
        safeError('loginInfo', loginInfoResponse, 'Bullhorn loginInfo failed.'),
        { status: 502 }
      );
    }

    const loginInfo = JSON.parse(loginInfoText);
    const oauthBase = loginInfo.oauthUrl;
    const restBase = loginInfo.restUrl;

    if (!oauthBase || !restBase) {
      return Response.json(
        { ok: false, stage: 'loginInfo', error: 'Bullhorn did not return oauthUrl/restUrl.' },
        { status: 502 }
      );
    }

    // 2) Obtain an authorization code programmatically using the dedicated API user.
    // Bullhorn documents action=Login + username/password for this server-side flow.
    const authorizeUrl = new URL(`${oauthBase}/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('action', 'Login');
    authorizeUrl.searchParams.set('username', username);
    authorizeUrl.searchParams.set('password', password);
    if (redirectUri) authorizeUrl.searchParams.set('redirect_uri', redirectUri);

    const authorizeResponse = await fetch(authorizeUrl, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
    });

    const location = authorizeResponse.headers.get('location');
    if (!location) {
      const authBody = await authorizeResponse.text();
      return Response.json(
        {
          ok: false,
          stage: 'authorize',
          status: authorizeResponse.status,
          error: 'Bullhorn authorization did not return a redirect with an authorization code.',
          hint: 'This can happen if the API user must accept terms once, the credentials are rejected, or the OAuth redirect URI needs to be configured.',
          responsePreview: authBody.slice(0, 300),
        },
        { status: 502 }
      );
    }

    const redirectLocation = new URL(location, redirectUri || 'https://localhost');
    const authError = redirectLocation.searchParams.get('error');
    const code = redirectLocation.searchParams.get('code');

    if (authError || !code) {
      return Response.json(
        {
          ok: false,
          stage: 'authorize',
          error: authError || 'No authorization code in Bullhorn redirect.',
          redirectHost: redirectLocation.host,
        },
        { status: 502 }
      );
    }

    // 3) Exchange the authorization code for an OAuth access token.
    const tokenUrl = new URL(`${oauthBase}/token`);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('client_id', clientId);
    tokenUrl.searchParams.set('client_secret', clientSecret);
    if (redirectUri) tokenUrl.searchParams.set('redirect_uri', redirectUri);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'follow',
    });
    const tokenText = await tokenResponse.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      tokenData = null;
    }

    if (!tokenResponse.ok || !tokenData?.access_token) {
      return Response.json(
        safeError('token', tokenResponse, tokenData?.error_description || tokenData?.error || 'Access token exchange failed.'),
        { status: 502 }
      );
    }

    // 4) Exchange the OAuth access token for a Bullhorn REST session.
    const restLoginUrl = new URL(`${restBase}/login`);
    restLoginUrl.searchParams.set('version', '*');
    restLoginUrl.searchParams.set('access_token', tokenData.access_token);

    const restLoginResponse = await fetch(restLoginUrl, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'follow',
    });
    const restLoginText = await restLoginResponse.text();
    let restLogin;
    try {
      restLogin = JSON.parse(restLoginText);
    } catch {
      restLogin = null;
    }

    if (!restLoginResponse.ok || !restLogin?.BhRestToken || !restLogin?.restUrl) {
      return Response.json(
        safeError('restLogin', restLoginResponse, restLogin?.errorMessage || 'REST session login failed.'),
        { status: 502 }
      );
    }

    // 5) Prove read access by retrieving a very small client-corporation sample.
    const entityUrl = new URL(`${restLogin.restUrl}search/ClientCorporation`);
    entityUrl.searchParams.set('BhRestToken', restLogin.BhRestToken);
    entityUrl.searchParams.set('query', 'isDeleted:0');
    entityUrl.searchParams.set('fields', 'id,name,status,address');
    entityUrl.searchParams.set('count', '3');
    entityUrl.searchParams.set('start', '0');

    const entityResponse = await fetch(entityUrl, {
      cache: 'no-store',
    });
    const entityText = await entityResponse.text();
    let entityData;
    try {
      entityData = JSON.parse(entityText);
    } catch {
      entityData = null;
    }

    if (!entityResponse.ok) {
      return Response.json(
        safeError('readTest', entityResponse, entityData?.errorMessage || 'ClientCorporation read test failed.'),
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      stage: 'complete',
      dataCenterId: loginInfo.dataCenterId ?? null,
      superClusterId: loginInfo.superClusterId ?? null,
      oauthHost: new URL(oauthBase).host,
      restHost: new URL(restBase).host,
      redirectUriConfigured: Boolean(redirectUri),
      refreshTokenAvailable: Boolean(tokenData.refresh_token),
      restSessionEstablished: true,
      readAccessConfirmed: true,
      sample: Array.isArray(entityData?.data) ? entityData.data : [],
    });
  } catch (error) {
    console.error('Bullhorn session test failed:', error?.message || error);
    return Response.json(
      { ok: false, stage: 'unexpected', error: 'Unexpected Bullhorn authentication test error.' },
      { status: 500 }
    );
  }
}
