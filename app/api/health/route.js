export async function GET() {
  return Response.json({ ok: true, service: 'upply-integration-api', timestamp: new Date().toISOString() });
}
