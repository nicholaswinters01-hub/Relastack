import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@platform/db';
import { SERVER_ENV, type ServerEnv } from '../config.provider';

/**
 * Owns the single PrismaClient instance for the API process.
 *
 * Connects explicitly on module init so that a bad DATABASE_URL fails at
 * startup — loudly and immediately — rather than on the first request that
 * happens to touch the database.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  public readonly client: PrismaClient;

  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {
    this.client = createPrismaClient({
      databaseUrl: env.DATABASE_URL,
      logQueries: env.LOG_LEVEL === 'trace',
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
}
