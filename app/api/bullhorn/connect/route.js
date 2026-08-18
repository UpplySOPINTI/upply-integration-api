import crypto from 'crypto';

export async function GET() {
  const clientId = process.env.BULLHORN_CLIENT_ID;
  const redirectUri = process.env.BULLHORN_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return Response.json({ ok: false, error: 'Bullhorn OAuth is not configured yet.' }, { status: 503 });
  }

  const state = crypto.randomBytes(24).toString('hex');
  const url = new URL('https://auth.bullhornstaffing.com/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  const response = Response.redirect(url.toString(), 302);
  response.headers.append('Set-Cookie', `bh_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return response;
}
