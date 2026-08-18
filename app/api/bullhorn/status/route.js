export async function GET() {
  const configured = Boolean(process.env.BULLHORN_CLIENT_ID && process.env.BULLHORN_CLIENT_SECRET && process.env.BULLHORN_REDIRECT_URI);
  return Response.json({ ok: true, provider: 'bullhorn', configured, redirectUri: process.env.BULLHORN_REDIRECT_URI || null });
}
