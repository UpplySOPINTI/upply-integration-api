import { internalAccessFailure } from '../../../../lib/internal-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const accessFailure = internalAccessFailure(request);
  if (accessFailure) return accessFailure;

  try {
    const required = {
      BULLHORN_CLIENT_ID: process.env.BULLHORN_CLIENT_ID,
      BULLHORN_CLIENT_SECRET: process.env.BULLHORN_CLIENT_SECRET,
      BULLHORN_USERNAME: process.env.BULLHORN_USERNAME,
      BULLHORN_PASSWORD: process.env.BULLHORN_PASSWORD,
    };

    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length) {
      return Response.json(
        {
          ok: false,
          envConfigured: false,
          missing,
          error: 'Missing Bullhorn environment variables.',
        },
        { status: 503 }
      );
    }

    const loginInfoUrl = new URL(
      'https://rest.bullhornstaffing.com/rest-services/loginInfo'
    );
    loginInfoUrl.searchParams.set('username', required.BULLHORN_USERNAME);

    const response = await fetch(loginInfoUrl, {
      method: 'GET',
      cache: 'no-store',
    });

    const raw = await response.text();
    let loginInfo = null;

    try {
      loginInfo = JSON.parse(raw);
    } catch {
      loginInfo = raw;
    }

    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          envConfigured: true,
          bullhornReachable: false,
          status: response.status,
          error: 'Bullhorn loginInfo request failed.',
        },
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      envConfigured: true,
      bullhornReachable: true,
      usernameConfigured: true,
      dataCenterId: loginInfo?.dataCenterId ?? null,
      superClusterId: loginInfo?.superClusterId ?? null,
      oauthHost: loginInfo?.oauthUrl ? new URL(loginInfo.oauthUrl).host : null,
      restHost: loginInfo?.restUrl ? new URL(loginInfo.restUrl).host : null,
    });
  } catch (error) {
    console.error('Bullhorn connection test failed', error);

    return Response.json(
      {
        ok: false,
        error: 'Unexpected Bullhorn connection test error.',
      },
      { status: 500 }
    );
  }
}
