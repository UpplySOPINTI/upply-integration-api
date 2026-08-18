export async function GET() {
  const checks = {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    INTEGRATION_ENCRYPTION_KEY: Boolean(process.env.INTEGRATION_ENCRYPTION_KEY),
    BULLHORN_CLIENT_ID: Boolean(process.env.BULLHORN_CLIENT_ID),
    BULLHORN_CLIENT_SECRET: Boolean(process.env.BULLHORN_CLIENT_SECRET),
    BULLHORN_REDIRECT_URI: Boolean(process.env.BULLHORN_REDIRECT_URI),
  };
  return Response.json({ ok: Object.values(checks).slice(0,3).every(Boolean), checks });
}
