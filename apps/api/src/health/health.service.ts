import { Inject, Injectable, Logger } from '@nestjs/common';
import { pingDatabase } from '@platform/db';
import type { HealthResponse } from '@platform/shared';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /**
   * Report process and dependency health.
   *
   * Never throws. A health endpoint that throws on failure is useless — it
   * must report the failure as data so monitoring can distinguish "the
   * database is down" from "the process is down".
   */
  async check(): Promise<HealthResponse> {
    const database = await this.checkDatabase();

    return {
      status: database.status === 'connected' ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: this.env.NODE_ENV,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      dependencies: { database },
    };
  }

  private async checkDatabase(): Promise<HealthResponse['dependencies']['database']> {
    const startedAt = Date.now();

    try {
      await pingDatabase(this.prisma.client);
      return { status: 'connected', latencyMs: Date.now() - startedAt, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Database health check failed: ${message}`);

      // The message is returned to aid local debugging. Phase 20 (production
      // hardening) will redact this in production, since connection strings
      // can surface in driver errors.
      return { status: 'disconnected', latencyMs: null, error: message };
    }
  }
}
