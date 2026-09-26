import { Pool } from 'pg';
import { loadEnv } from './env';
import type { SubscribeInput, SubscribeResult } from './waitlist-types';

/**
 * Waitlist signups, stored in a database you own.
 *
 * A plain connection string and raw SQL rather than Prisma or a vendor SDK.
 * Two reasons:
 *
 *   - The marketing site deliberately depends on no workspace package, which
 *     is what lets it build and deploy without the API, the schema or the
 *     shared contracts. Reaching for `@platform/db` would give that up for one
 *     table.
 *   - A connection string is portable. The same code runs against Neon today
 *     and against your own Postgres later; moving is changing one value.
 *
 * The columns are shaped like a CRM lead on purpose. When the product is
 * deployed, these rows become customers at stage LEAD with one INSERT ... SELECT
 * rather than a hand-transcribed spreadsheet.
 */

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email        text NOT NULL UNIQUE,
    note         text,
    source       text NOT NULL DEFAULT 'waitlist',
    consented_at timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  )
`;

const INSERT = `
  INSERT INTO waitlist_signups (email, note, source, consented_at)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (email) DO NOTHING
  RETURNING id
`;

/**
 * One pool per process, reused across warm invocations.
 *
 * A serverless function that opens a connection per request exhausts the
 * database's connection limit under any real traffic. Holding the pool at
 * module scope means it survives between invocations on the same instance.
 */
let pool: Pool | null = null;
let ready: Promise<void> | null = null;

/**
 * Whether to negotiate TLS for a given connection string.
 *
 * Hosted Postgres requires it. A Postgres running in a local container
 * usually has no certificate at all and refuses the handshake outright, so a
 * hard-coded `ssl: true` makes the thing impossible to test locally — which is
 * how this was found.
 *
 * `sslmode` in the string wins if it is there; otherwise the rule is simply
 * whether the database is on this machine.
 */
function sslFor(connectionString: string): { rejectUnauthorized: boolean } | false {
  const mode = /[?&]sslmode=([a-z-]+)/i.exec(connectionString)?.[1]?.toLowerCase();

  if (mode === 'disable') return false;

  if (mode === undefined) {
    const host = (() => {
      try {
        return new URL(connectionString).hostname;
      } catch {
        return '';
      }
    })();

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  }

  // Encrypted, but without checking who signed the certificate. Hosted
  // providers use chains that are not in the Node bundle, and `verify-full`
  // would need their CA shipped alongside. The traffic is still protected from
  // reading; what is given up is proof of who is at the other end.
  return { rejectUnauthorized: false };
}

function getPool(): Pool {
  if (!pool) {
    const connectionString = loadEnv().DATABASE_URL ?? '';

    pool = new Pool({
      connectionString,
      ssl: sslFor(connectionString),
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }

  return pool;
}

/**
 * Creates the table if it is missing, once per process.
 *
 * Deliberately not a migration. There is one table, it is never altered, and
 * requiring a migration step before the site can accept its first signup would
 * be ceremony with no payoff. The product's own schema keeps its migrations;
 * this is not that.
 */
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(CREATE_TABLE)
      .then(() => undefined)
      .catch((error) => {
        // Clear it so the next request retries rather than caching a failure
        // for the lifetime of the instance.
        ready = null;
        throw error;
      });
  }

  return ready;
}

export interface SignupRow {
  email: string;
  note: string | null;
  createdAt: string;
}

/** Newest first. Only ever called from behind `requireAdmin`. */
export async function listSignups(limit = 1000): Promise<{ total: number; rows: SignupRow[] }> {
  await ensureTable();

  const [count, result] = await Promise.all([
    getPool().query<{ total: string }>('SELECT count(*)::text AS total FROM waitlist_signups'),
    getPool().query<{ email: string; note: string | null; created_at: Date }>(
      'SELECT email, note, created_at FROM waitlist_signups ORDER BY created_at DESC LIMIT $1',
      [limit],
    ),
  ]);

  return {
    total: Number(count.rows[0]?.total ?? 0),
    rows: result.rows.map((row) => ({
      email: row.email,
      note: row.note,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function subscribeToPostgres(input: SubscribeInput): Promise<SubscribeResult> {
  try {
    await ensureTable();

    // Parameterised, never interpolated. The email arrives from a public form,
    // which is exactly the shape of input that gets a database dropped.
    const result = await getPool().query(INSERT, [
      input.email,
      input.note ?? null,
      'waitlist',
      input.consentedAt,
    ]);

    // No row returned means ON CONFLICT fired: already on the list.
    return result.rowCount === 0 ? { ok: true, duplicate: true } : { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}
