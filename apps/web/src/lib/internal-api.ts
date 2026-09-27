/**
 * How this server talks to the API.
 *
 * Server-only. Both values stay out of the browser bundle: there is no
 * NEXT_PUBLIC_ prefix, and nothing a client component imports reaches here.
 */

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * The real visitor's address, as Vercel reports it.
 *
 * Vercel overwrites X-Forwarded-For with the connecting client and does not
 * pass on a value the client sent, so on Vercel this cannot be forged. On a
 * host that forwards the header untouched it could be; revisit this before
 * moving the web tier anywhere else.
 */
function clientIpFrom(headers: Headers): string | undefined {
  const raw =
    headers.get('x-vercel-forwarded-for') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for');

  return raw?.split(',')[0]?.trim() || undefined;
}

/** The secret proves the request came from us; the address is only believed because of it. */
export function internalHeaders(incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {};

  const secret = process.env.INTERNAL_API_SECRET;
  if (secret) headers['x-internal-secret'] = secret;

  const clientIp = clientIpFrom(incoming);
  if (clientIp) headers['x-client-ip'] = clientIp;

  return headers;
}
