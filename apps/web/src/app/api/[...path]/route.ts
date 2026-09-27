import type { NextRequest } from 'next/server';
import { API_URL, internalHeaders } from '@/lib/internal-api';

/**
 * The browser's calls to the API, relayed through this origin.
 *
 * Same origin keeps the session cookie first-party. It used to be a plain
 * rewrite, which cannot add headers — and the API now answers only requests
 * that carry the internal secret and the visitor's real address, so the relay
 * has to be code.
 *
 * Only headers the API actually reads are forwarded. Passing everything along
 * would let a browser send its own `x-internal-secret` or `x-client-ip` and
 * have them arrive looking like ours.
 */

export const dynamic = 'force-dynamic';

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'cookie', 'user-agent'];

// Undici has already decoded the body, so passing the encoding on would make
// the browser try to decode it twice. Length changes with it.
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

async function relay(request: NextRequest): Promise<Response> {
  const headers: Record<string, string> = {};

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  Object.assign(headers, internalHeaders(request.headers));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const upstream = await fetch(`${API_URL}${request.nextUrl.pathname}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });

  const responseHeaders = new Headers();

  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
  });

  // Copied one by one: iterating Headers folds several Set-Cookie values into
  // one comma-joined string, which browsers cannot parse back apart.
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
