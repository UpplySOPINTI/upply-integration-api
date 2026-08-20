import { getBullhornConnectionSummary } from '../../../../lib/integration-store.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = Boolean(
    process.env.BULLHORN_CLIENT_ID &&
      process.env.BULLHORN_CLIENT_SECRET &&
      process.env.BULLHORN_USERNAME &&
      process.env.BULLHORN_REDIRECT_URI &&
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.INTEGRATION_ENCRYPTION_KEY
  );

  let connection = null;
  if (configured) {
    try {
      connection = await getBullhornConnectionSummary();
    } catch (error) {
      console.error('Unable to read Bullhorn connection status', error);
    }
  }

  return Response.json(
    {
      ok: true,
      provider: 'bullhorn',
      configured,
      connection,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
