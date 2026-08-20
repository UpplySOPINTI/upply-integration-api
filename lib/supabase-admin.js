function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase server configuration is incomplete.');
  }

  return { url: url.replace(/\/$/, ''), serviceRoleKey };
}

export async function supabaseRest(table, { method = 'GET', query, body, prefer } = {}) {
  const { url, serviceRoleKey } = config();
  const endpoint = new URL(`${url}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(query || {})) {
    endpoint.searchParams.set(key, value);
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: 'application/json',
  };

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'object' && data ? data.message || data.code : null;
    throw new Error(`Supabase ${table} request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }

  return data;
}
