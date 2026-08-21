import { createOauthState } from '../../../../lib/integration-store.js';

export const dynamic = 'force-dynamic';

function classifyAuthorizePage(html) {
  const normalized = html.toLowerCase();
  const mentionsInvalidCredentials =
    /invalid (?:user(?:name)?|credentials|password)|incorrect (?:user(?:name)?|password)|login failed|unable to log in/.test(
      normalized
    );
  const mentionsTerms = /terms (?:of (?:service|use)|and conditions)|accept (?:the )?terms/.test(
    normalized
  );
  const hasPasswordField = /<input[^>]+type=["']?password\b/.test(normalized);
  const hasUsernameField =
    /<input[^>]+(?:name|id)=["']?(?:user(?:name)?|login)\b/.test(normalized);
  const mentionsConsent = /\b(?:consent|authorize|authorization|allow access|agree)\b/.test(
    normalized
  );

  let pageKind = 'unknown';
  if (mentionsInvalidCredentials) pageKind = 'credentials_error';
  else if (mentionsTerms) pageKind = 'terms';
  else if (hasPasswordField || hasUsernameField) pageKind = 'login';
  else if (mentionsConsent) pageKind = 'consent';

  return {
    pageKind,
    hasPasswordField,
    hasUsernameField,
    mentionsTerms,
    mentionsConsent,
    mentionsInvalidCredentials,
  };
}

function authorizeHint(pageKind) {
  if (pageKind === 'terms') {
    return 'Bullhorn is still presenting its terms. Sign in interactively once with the dedicated API user and accept them for this API key.';
  }
  if (pageKind === 'credentials_error' || pageKind === 'login') {
    return 'Bullhorn returned its login page. Verify the dedicated API user password, account status, and API login permission with Bullhorn Support.';
  }
  if (pageKind === 'consent') {
    return 'Bullhorn is presenting an interactive consent step instead of redirecting. Ask Bullhorn Support to confirm consent for this API user and API key.';
  }
  return 'Ask Bullhorn Support to inspect this authorization attempt: their endpoint returned HTML instead of redirecting to the registered callback.';
}

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
      const contentType = authorizeResponse.headers.get('content-type') || 'unknown';
      const responseBody = await authorizeResponse.text();
      const diagnosis = classifyAuthorizePage(responseBody);

      // Never log or return the Bullhorn HTML: it may contain echoed form data or
      // implementation details. These booleans are sufficient to identify the
      // interactive page that interrupted the server-side OAuth flow.
      console.warn(
        JSON.stringify({
          level: 'warn',
          route: '/api/bullhorn/connect',
          stage: 'authorize',
          upstreamStatus: authorizeResponse.status,
          contentType: contentType.split(';', 1)[0],
          ...diagnosis,
        })
      );

      return Response.json(
        {
          ok: false,
          stage: 'authorize',
          status: authorizeResponse.status,
          error: 'Bullhorn authorization did not return an OAuth callback.',
          diagnosis,
          hint: authorizeHint(diagnosis.pageKind),
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
