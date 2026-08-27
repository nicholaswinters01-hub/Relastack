import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  logQueries?: boolean;
}

/**
 * Construct a PrismaClient.
 *
 * Centralising construction here means that when Phase 2 introduces
 * tenant-scoped clients (Row-Level Security session variables set per
 * transaction), there is exactly one place to change — no application code
 * instantiates PrismaClient directly.
 */
export function createPrismaClient({
  databaseUrl,
  logQueries = false,
}: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/**
 * Cheapest possible round-trip to the database.
 *
 * Used by the API health endpoint. `SELECT 1` touches no tables, so it stays
 * valid as the schema evolves and it measures true connection health rather
 * than the state of any particular table.
 */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}
