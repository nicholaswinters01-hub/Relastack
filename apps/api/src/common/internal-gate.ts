import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Only the web tier may call the API.
 *
 * In production every request reaches the API from the web tier's servers —
 * the browser's own calls through its /api proxy, and every server-rendered
 * page — so all of them arrive from a handful of Vercel addresses. The client
 * IP the web tier reports is therefore the only way to rate-limit per person,
 * and a claimed IP is only worth believing from a caller that proves it is
 * the web tier. Everyone else is refused outright.
 *
 * Refused with 404, not 403: nothing about the API should be discoverable by
 * probing it directly.
 */

/** Health checks come from the host, not the web tier. Must not touch the database. */
const OPEN_PATHS = new Set(['/api/v1/health/live']);

const SECRET_HEADER = 'x-internal-secret';
const CLIENT_IP_HEADER = 'x-client-ip';

/** Keyed on the request object, which is the same one guards and controllers receive. */
const trustedClientIps = new WeakMap<object, string>();

interface GateRequest {
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface GateReply {
  code(status: number): GateReply;
  send(body: unknown): GateReply;
}

interface HookHost {
  addHook(
    name: 'onRequest',
    hook: (request: GateRequest, reply: GateReply) => Promise<unknown>,
  ): unknown;
}

function header(request: GateRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function registerInternalGate(host: HookHost, secret: string | undefined): void {
  // Unset outside production (configuration requires it there), so local
  // development and the test suite reach the API directly.
  if (!secret) return;

  const expected = Buffer.from(secret);

  host.addHook('onRequest', async (request, reply) => {
    if (OPEN_PATHS.has(request.url.split('?')[0]!)) return;

    const given = Buffer.from(header(request, SECRET_HEADER) ?? '');

    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(404).send({ statusCode: 404, message: 'Not Found' });
    }

    const claimed = header(request, CLIENT_IP_HEADER)?.trim();
    if (claimed && isIP(claimed)) trustedClientIps.set(request, claimed);

    return undefined;
  });
}

/**
 * The address to rate-limit and record against.
 *
 * The web tier's report when the gate vouched for it; otherwise the socket
 * address, which `trustProxy: false` keeps a caller from overriding with a
 * forged X-Forwarded-For.
 */
export function clientIpOf(request: object & { ip?: string }): string {
  return trustedClientIps.get(request) ?? request.ip ?? 'unknown';
}
