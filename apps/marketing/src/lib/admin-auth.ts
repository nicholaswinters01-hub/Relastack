import { createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Sign-in for the two people who run the business, and nobody else.
 *
 * Accounts live in the ADMIN_USERS environment variable, not a table. There
 * are two of them, they change almost never, and a users table would need its
 * own sign-up, reset and management screens — every one of which is another
 * way in. `scripts/admin-setup.mjs` produces the value.
 *
 * Fails closed: with no accounts or no session secret configured, nobody can
 * sign in. A misconfiguration never breaks the public landing page, though —
 * that is why none of this is validated in `loadEnv`.
 */

export const ADMIN_COOKIE = 'rs_admin';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

interface StoredHash {
  /** The whole stored string. Folded into the session signature, so changing a password ends that person's sessions. */
  raw: string;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

interface AdminConfig {
  users: Map<string, StoredHash>;
  secret: string;
}

/** `scrypt$N$r$p$salt$hash`, base64url. Self-describing, so the setup script and this file cannot drift on parameters. */
function parseHash(raw: string): StoredHash | null {
  const parts = raw.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64url');
  const hash = Buffer.from(parts[5]!, 'base64url');

  // Bounded, so a mistyped value cannot make every sign-in allocate gigabytes.
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N > 2 ** 17 || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) return null;
  if (salt.length < 16 || hash.length < 32) return null;

  return { raw, N, r, p, salt, hash };
}

function loadConfig(): AdminConfig | null {
  const rawUsers = process.env.ADMIN_USERS?.trim();
  const secret = process.env.ADMIN_SESSION_SECRET?.trim() ?? '';

  if (!rawUsers || secret.length < MIN_SECRET_LENGTH) return null;

  const users = new Map<string, StoredHash>();

  for (const entry of rawUsers.split(',')) {
    const separator = entry.indexOf(':');
    const email = entry.slice(0, separator).trim().toLowerCase();
    const stored = parseHash(entry.slice(separator + 1).trim());

    if (separator <= 0 || !email || !stored) {
      // Skipped, not fatal: one bad entry should not lock the other person out.
      console.error('[admin] ignoring a malformed ADMIN_USERS entry');
      continue;
    }

    users.set(email, stored);
  }

  return users.size > 0 ? { users, secret } : null;
}

export function isAdminConfigured(): boolean {
  return loadConfig() !== null;
}

function derive(
  password: string,
  stored: Pick<StoredHash, 'N' | 'r' | 'p' | 'salt'>,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      stored.salt,
      length,
      { N: stored.N, r: stored.r, p: stored.p, maxmem: 256 * stored.N * stored.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

// Used when the email is unknown, so a wrong address takes as long as a wrong
// password. Otherwise the response time says which emails have accounts.
const DECOY = { N: 32768, r: 8, p: 1, salt: Buffer.alloc(16, 7) };

/** The account's email if the password matches, otherwise null. Never says which half was wrong. */
export async function verifyCredentials(email: string, password: string): Promise<string | null> {
  const config = loadConfig();
  if (!config) return null;

  const normalized = email.trim().toLowerCase();
  const stored = config.users.get(normalized);

  if (!stored) {
    await derive(password, DECOY, 64);
    return null;
  }

  const candidate = await derive(password, stored, stored.hash.length);

  return timingSafeEqual(candidate, stored.hash) ? normalized : null;
}

function sign(payload: string, stored: StoredHash, secret: string): string {
  return createHmac('sha256', secret)
    .update(payload)
    .update('\n')
    .update(stored.raw)
    .digest('base64url');
}

export function createSessionToken(email: string, now = Date.now()): string {
  const config = loadConfig();
  const stored = config?.users.get(email);

  if (!config || !stored) throw new Error('Cannot create a session for an unknown admin');

  const payload = Buffer.from(JSON.stringify({ e: email, x: now + SESSION_TTL_MS })).toString(
    'base64url',
  );

  return `${payload}.${sign(payload, stored, config.secret)}`;
}

/**
 * The signed-in admin's email, or null.
 *
 * Re-checked against ADMIN_USERS on every request: removing someone from the
 * variable, or changing their password, ends their sessions immediately.
 */
export function readSessionToken(token: string | undefined, now = Date.now()): string | null {
  const config = loadConfig();
  if (!config || !token) return null;

  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const { e: email, x: expiresAt } = (data ?? {}) as { e?: unknown; x?: unknown };
  if (typeof email !== 'string' || typeof expiresAt !== 'number') return null;

  const stored = config.users.get(email);
  if (!stored) return null;

  const expected = Buffer.from(sign(payload, stored, config.secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  return expiresAt > now ? email : null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export async function currentAdmin(): Promise<string | null> {
  return readSessionToken((await cookies()).get(ADMIN_COOKIE)?.value);
}

/** For pages: the admin's email, or a redirect to the sign-in page. */
export async function requireAdmin(): Promise<string> {
  const email = await currentAdmin();
  if (!email) redirect('/admin/login');
  return email;
}

/**
 * Whether a form post came from this site.
 *
 * The session cookie is SameSite=Strict already; this is the second lock, so a
 * page elsewhere cannot sign someone in or out behind their back. A request
 * with no Origin at all is refused — every current browser sends one on POST.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
