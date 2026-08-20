const LOGIN_INFO_URL = 'https://rest.bullhornstaffing.com/rest-services/loginInfo';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function jsonResponse(response, stage) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = body?.error_description || body?.error || body?.errorMessage;
    throw new Error(`Bullhorn ${stage} failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }

  return body;
}

export async function discoverBullhorn() {
  const loginInfoUrl = new URL(LOGIN_INFO_URL);
  loginInfoUrl.searchParams.set('username', required('BULLHORN_USERNAME'));

  const response = await fetch(loginInfoUrl, { cache: 'no-store' });
  const loginInfo = await jsonResponse(response, 'loginInfo');

  if (!loginInfo?.oauthUrl || !loginInfo?.restUrl) {
    throw new Error('Bullhorn loginInfo did not return oauthUrl/restUrl.');
  }

  return loginInfo;
}

export async function exchangeAuthorizationCode({ code }) {
  const loginInfo = await discoverBullhorn();
  const tokenUrl = new URL(`${String(loginInfo.oauthUrl).replace(/\/$/, '')}/token`);
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  tokenUrl.searchParams.set('code', code);
  tokenUrl.searchParams.set('client_id', required('BULLHORN_CLIENT_ID'));
  tokenUrl.searchParams.set('client_secret', required('BULLHORN_CLIENT_SECRET'));
  tokenUrl.searchParams.set('redirect_uri', required('BULLHORN_REDIRECT_URI'));

  const response = await fetch(tokenUrl, { method: 'POST', cache: 'no-store' });
  const tokenData = await jsonResponse(response, 'token exchange');
  if (!tokenData?.access_token) throw new Error('Bullhorn token exchange returned no access token.');

  const expiresIn = Number(tokenData.expires_in || 600);
  return {
    ...tokenData,
    expires_at: new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString(),
    loginInfo,
  };
}

export async function refreshBullhornAccessToken({ refreshToken, oauthUrl }) {
  if (!refreshToken || !oauthUrl) throw new Error('Bullhorn refresh metadata is incomplete.');

  const tokenUrl = new URL(`${String(oauthUrl).replace(/\/$/, '')}/token`);
  tokenUrl.searchParams.set('grant_type', 'refresh_token');
  tokenUrl.searchParams.set('refresh_token', refreshToken);
  tokenUrl.searchParams.set('client_id', required('BULLHORN_CLIENT_ID'));
  tokenUrl.searchParams.set('client_secret', required('BULLHORN_CLIENT_SECRET'));

  const response = await fetch(tokenUrl, { method: 'POST', cache: 'no-store' });
  const tokenData = await jsonResponse(response, 'token refresh');
  if (!tokenData?.access_token) throw new Error('Bullhorn token refresh returned no access token.');

  const expiresIn = Number(tokenData.expires_in || 600);
  return {
    ...tokenData,
    expires_at: new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString(),
  };
}

export async function loginToBullhornRest({ accessToken, restBase }) {
  const loginInfo = restBase ? null : await discoverBullhorn();
  const base = restBase || loginInfo.restUrl;
  const loginUrl = new URL(`${String(base).replace(/\/$/, '')}/login`);
  loginUrl.searchParams.set('version', '*');
  loginUrl.searchParams.set('access_token', accessToken);

  const response = await fetch(loginUrl, { method: 'POST', cache: 'no-store' });
  const session = await jsonResponse(response, 'REST login');

  if (!session?.BhRestToken || !session?.restUrl) {
    throw new Error('Bullhorn REST login returned no session token/restUrl.');
  }

  return session;
}
