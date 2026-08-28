import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_ENV } from '../config.provider';
import { makeTestEnv } from '../test-support/test-env';
import { PrismaService } from '../prisma/prisma.service';
import { HealthService } from './health.service';

const testEnv = makeTestEnv();

/**
 * Unit tests for health reporting. The database is mocked, so these run
 * without Docker — they verify reporting logic, not connectivity.
 */
describe('HealthService', () => {
  let queryRaw: ReturnType<typeof vi.fn>;

  async function buildService(): Promise<HealthService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: SERVER_ENV, useValue: testEnv },
        { provide: PrismaService, useValue: { client: { $queryRaw: queryRaw } } },
      ],
    }).compile();

    return moduleRef.get(HealthService);
  }

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
  });

  it('reports ok when the database responds', async () => {
    const service = await buildService();
    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.dependencies.database.status).toBe('connected');
    expect(result.dependencies.database.error).toBeNull();
    expect(result.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded rather than throwing when the database is unreachable', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    const service = await buildService();
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.dependencies.database.status).toBe('disconnected');
    expect(result.dependencies.database.error).toContain('connection refused');
    expect(result.dependencies.database.latencyMs).toBeNull();
  });

  it('reports the configured environment and a valid ISO timestamp', async () => {
    const service = await buildService();
    const result = await service.check();

    expect(result.environment).toBe('test');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
