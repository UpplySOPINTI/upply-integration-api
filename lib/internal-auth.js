import crypto from 'crypto';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '', 'utf8');
  const rightBuffer = Buffer.from(right || '', 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isInternalRequestAuthorized(request) {
  const expected = process.env.INTEGRATION_ADMIN_KEY;
  if (!expected) return false;

  const authorization = request.headers.get('authorization') || '';
  const [scheme, token] = authorization.split(' ', 2);
  return scheme === 'Bearer' && safeEqual(token, expected);
}

export function internalAccessFailure(request) {
  if (!process.env.INTEGRATION_ADMIN_KEY) {
    return Response.json(
      { ok: false, error: 'Internal integration access is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!isInternalRequestAuthorized(request)) {
    return Response.json(
      { ok: false, error: 'Unauthorized.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return null;
}
