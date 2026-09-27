import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Single re-export point for everything Prisma generates.
 *
 * Application code imports models and enums from `@platform/db`, never from
 * `@prisma/client` directly. That indirection means the generated client can
 * move, be renamed, or be wrapped without touching call sites.
 */
export * from '@prisma/client';

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  logQueries?: boolean;

  /**
   * Log Prisma's own errors. Defaults to true.
   *
   * Test suites pass false: several deliberately provoke failures (duplicate
   * emails, cross-tenant writes blocked by RLS) and assert they are rejected,
   * so printing each one buries genuine failures in expected output. Errors
   * still surface — they are thrown, and a test that does not expect one still
   * fails on it.
   */
  logErrors?: boolean;

  /** Told when a closed connection forced a reconnect. This package never logs itself. */
  onReconnect?: () => void;
}

export function createPrismaClient({
  databaseUrl,
  logQueries = false,
  logErrors = true,
  onReconnect,
}: CreatePrismaClientOptions): PrismaClient {
  // Note this package never reads process.env — configuration is validated
  // once, in @platform/config, and passed in. Deciding here would put a second
  // source of truth in the codebase.
  const log: Array<'query' | 'warn' | 'error'> = ['warn'];

  if (logQueries) log.unshift('query');
  if (logErrors) log.push('error');

  const base = new PrismaClient({
    datasources: { db: { url: withIdleLimit(databaseUrl) } },
    log,
  });

  // Queries made outside a transaction (session lookups, mostly) get the same
  // recovery as transactions do below. The cast keeps call sites on the plain
  // PrismaClient type; an extension changes no method's shape.
  const client = base.$extends({
    query: {
      $allOperations: ({ args, query }) => withReconnect(base, () => query(args)),
    },
  }) as unknown as PrismaClient;

  if (onReconnect) {
    reconnectListeners.set(base, onReconnect);
    reconnectListeners.set(client, onReconnect);
  }

  return client;
}

const reconnectListeners = new WeakMap<object, () => void>();

/**
 * Connections idle longer than this are discarded rather than reused.
 *
 * Hosted Postgres that sleeps when idle (Neon, after five minutes) closes every
 * connection as it goes. Prisma does not notice: it keeps handing out the dead
 * ones, and every query fails until the process restarts — measured, not
 * assumed. A limit well under five minutes means a connection old enough to
 * have been closed is never reused. An explicit value in the URL wins.
 */
const IDLE_LIMIT_SECONDS = 60;

function withIdleLimit(url: string): string {
  if (/[?&]max_idle_connection_lifetime=/.test(url)) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}max_idle_connection_lifetime=${IDLE_LIMIT_SECONDS}`;
}

/** Prisma's code for "Server has closed the connection". */
const CONNECTION_CLOSED = 'P1017';

const resets = new WeakMap<object, Promise<void>>();

/**
 * Retry once on a fresh pool if the server closed the connection.
 *
 * The idle limit covers a database that slept. This covers one that dropped
 * connections still in use — a restart, a failover — where Prisma, left alone,
 * never recovers. Disconnecting discards the whole pool; the retry reconnects.
 *
 * Safe to retry because a transaction on a closed connection was never
 * committed. The narrow exception — the server committing and then dropping
 * the connection before replying — could repeat a write, which is far rarer
 * than the outage it prevents.
 */
export async function withReconnect<T>(client: PrismaClient, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== CONNECTION_CLOSED) throw error;

    reconnectListeners.get(client)?.();

    // Shared, so a burst of failing requests resets the pool once, not once each.
    let reset = resets.get(client);
    if (!reset) {
      reset = client.$disconnect().finally(() => resets.delete(client));
      resets.set(client, reset);
    }
    await reset;

    return work();
  }
}

function transaction<T>(
  client: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return withReconnect(client, () => client.$transaction(work));
}

/**
 * Cheapest possible round-trip to the database. Used by the health endpoint.
 */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

/**
 * Identity of the caller, used to establish database-level tenant context.
 */
export interface TenantContext {
  organizationId: string;
  userId: string;
}

/**
 * A Prisma transaction client — the same API as PrismaClient minus the
 * transaction-control methods that cannot be nested.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * PostgreSQL rejects parameter placeholders in SET, so the value is
 * interpolated. Validating it as a UUID first is what keeps that safe — a
 * value that is not a UUID never reaches the statement.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantContextError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid tenant context: ${field} must be a UUID, received ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantContextError';
  }
}

/**
 * Run work with database-level tenant context established.
 *
 * THE isolation boundary. Every query touching tenant-owned data goes through
 * here, and this is the only place in the codebase that sets those settings.
 *
 * `SET LOCAL` scopes the values to the surrounding transaction, so they are
 * discarded on commit or rollback. That matters enormously with a connection
 * pool: a plain `SET` would persist on the pooled connection and leak one
 * request's tenant context into whichever request picked up that connection
 * next — a cross-tenant data leak caused purely by connection reuse.
 *
 * Because policies fail closed when the settings are absent, code that forgets
 * to use this helper sees an empty database rather than someone else's data.
 */
export async function withTenant<T>(
  client: PrismaClient,
  context: TenantContext,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.organizationId)) {
    throw new InvalidTenantContextError('organizationId', context.organizationId);
  }
  if (!UUID_PATTERN.test(context.userId)) {
    throw new InvalidTenantContextError('userId', context.userId);
  }

  return transaction(client, async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_organization_id = '${context.organizationId}'`,
    );
    await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${context.userId}'`);

    return work(tx);
  });
}

/**
 * Run work with only the caller's identity established — no organization.
 *
 * Exists for exactly one situation: a just-authenticated user needs to
 * discover which organization they belong to, which necessarily happens before
 * any organization context can exist. The membership policy permits reading
 * rows whose `user_id` is the caller, and nothing more.
 *
 * This is NOT a bypass. Tenant-owned tables remain invisible — only the
 * caller's own membership rows are readable.
 */
export async function withUserOnly<T>(
  client: PrismaClient,
  userId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(userId)) {
    throw new InvalidTenantContextError('userId', userId);
  }

  return transaction(client, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userId}'`);

    return work(tx);
  });
}

/**
 * Run work with organization context but no user identity.
 *
 * For lookups that concern an organization rather than a person — reading the
 * organization an invitation points at, before the invitee is a member of
 * anything. Sets one setting rather than two, so the membership policy's
 * "or it is your own row" branch cannot match: a caller in this context sees
 * the organization's data, never anybody's personal membership rows.
 */
export async function withOrganization<T>(
  client: PrismaClient,
  organizationId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new InvalidTenantContextError('organizationId', organizationId);
  }

  return transaction(client, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_organization_id = '${organizationId}'`);

    return work(tx);
  });
}

/**
 * Run work authorised by possession of an invitation token.
 *
 * The invitation policy admits a row whose token hash matches this setting, so
 * the caller can read exactly the one invitation they hold and nothing else.
 * Used only when accepting an invitation, which by definition happens before
 * the invitee belongs to any organization.
 *
 * NOT a bypass: it grants reading one row, and the policy's WITH CHECK still
 * forbids writing anything outside a real tenant context.
 */
export async function withInvitationToken<T>(
  client: PrismaClient,
  tokenHash: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  // The hash is produced by the application from a token, never taken from
  // user input directly, but it is interpolated into a SET statement — so
  // require it to be exactly what SHA-256 hex looks like.
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
    throw new InvalidTenantContextError('invitationTokenHash', tokenHash);
  }

  return transaction(client, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_invitation_token = '${tokenHash}'`);

    return work(tx);
  });
}

/**
 * Platform background work, across every tenant.
 *
 * The dispatcher and the periodic sweeps genuinely have to see rows belonging
 * to every organization — an outbox serving one tenant is not an outbox. There
 * is no single tenant to set, so `withTenant` cannot be used, and running
 * without any context sees NOTHING because RLS fails closed. That is rule 3
 * doing its job, and it is why this hatch is explicit rather than implied.
 *
 * Deliberately narrow. The policy branch it unlocks exists on exactly three
 * tables — domain_events, subscriptions and job_series — which are the ones a
 * worker must scan to know what needs doing. It grants nothing on customers,
 * tasks, jobs or notifications; those writes still go through `withTenant` for
 * one organization at a time, so the work a worker performs is as scoped as
 * anything a request does.
 *
 * NOT a superuser connection. The application still connects as `platform_app`
 * and every other policy still applies, which is the difference between a
 * narrow hatch and turning row-level security off.
 */
export async function withPlatformWorker<T>(
  client: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return transaction(client, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.platform_worker = 'on'`);

    return work(tx);
  });
}

export { Prisma, PrismaClient };
