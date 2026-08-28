import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { healthResponseSchema } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-test-app';

/**
 * End-to-end health checks.
 *
 * These boot the real application against the real database, so they REQUIRE
 * `pnpm db:up` and an applied migration. They are the proof that Phase 0
 * actually works — the unit tests only prove the logic is right in isolation.
 */
describe('Health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/v1/health returns 200 with a real database connection', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    // Validating against the shared contract proves the API and the web client
    // genuinely agree on the response shape.
    const parsed = healthResponseSchema.safeParse(body);

    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.dependencies.database.status).toBe('connected');
    expect(body.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/v1/health/live returns 200 without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('returns 404 for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
  });

  it('serves the API only under the versioned prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(404);
  });
});
