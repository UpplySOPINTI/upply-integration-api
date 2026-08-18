export async function GET(request) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) return Response.json({ ok: false, error }, { status: 400 });
  if (!code) return Response.json({ ok: false, error: 'Missing authorization code.' }, { status: 400 });

  return Response.json({
    ok: true,
    status: 'callback_ready',
    message: 'Bullhorn authorization code received. Token exchange will activate when credentials are configured.',
    state_present: Boolean(state)
  });
}
