import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { isTest } from '@platform/config';
import {
  createPrismaClient,
  withTenant,
  withInvitationToken,
  withOrganization,
  withPlatformWorker,
  withUserOnly,
  type PrismaClient,
  type TenantContext,
  type TransactionClient,
} from '@platform/db';
import { SERVER_ENV, type ServerEnv } from '../config.provider';

/**
 * Owns the database connection for the API process.
 *
 * Connects as the UNPRIVILEGED application role, so every query is subject to
 * row-level security. The migration role is never used at runtime — it is a
 * superuser, and superusers bypass RLS unconditionally, which would leave
 * every policy in place and enforcing nothing.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  public readonly client: PrismaClient;

  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {
    const appUrl = env.DATABASE_URL_APP ?? env.DATABASE_URL;

    if (!env.DATABASE_URL_APP || env.DATABASE_URL_APP === env.DATABASE_URL) {
      // Not fatal outside production (config refuses to start there), but it
      // must be impossible to miss: in this state tenant isolation is resting
      // entirely on application code remembering to filter.
      this.logger.error(
        'DATABASE_URL_APP is unset or identical to DATABASE_URL. The application is ' +
          'connecting as the migration role, which BYPASSES row-level security. ' +
          'Tenant isolation is NOT being enforced by the database.',
      );
    }

    this.client = createPrismaClient({
      databaseUrl: appUrl,
      logQueries: env.LOG_LEVEL === 'trace',
      // Suites deliberately provoke failures and assert they are rejected;
      // logging each one buries real failures in expected output.
      logErrors: !isTest(env),
      onConnectionLost: (error) =>
        this.logger.warn(`The database closed an idle connection (${error.message})`),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Run work with full tenant context. Use this for anything touching
   * tenant-owned data.
   */
  withTenant<T>(context: TenantContext, work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTenant(this.client, context, work);
  }

  /**
   * Run work with only the caller's identity — for resolving which
   * organization a just-authenticated user belongs to. See withUserOnly.
   */
  withUserOnly<T>(userId: string, work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withUserOnly(this.client, userId, work);
  }

  /**
   * Run work authorised by possession of an invitation token hash.
   * See withInvitationToken — grants reading exactly one invitation row.
   */
  withInvitationToken<T>(
    tokenHash: string,
    work: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withInvitationToken(this.client, tokenHash, work);
  }

  /**
   * Cross-tenant reads for background work. See withPlatformWorker.
   *
   * Unlocks a narrow policy branch on three tables the dispatcher and sweeps
   * must scan. Everything they WRITE still goes through withTenant, one
   * organization at a time.
   */
  withPlatformWorker<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withPlatformWorker(this.client, work);
  }

  /** Organization context without a user identity. See withOrganization. */
  withOrganization<T>(
    organizationId: string,
    work: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withOrganization(this.client, organizationId, work);
  }
}
