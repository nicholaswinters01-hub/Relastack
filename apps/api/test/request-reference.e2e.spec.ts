import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-test-app';

/**
 * Every response carries a reference to find it in the logs, and the error
 * filter leaves ordinary refusals exactly as they were.
 */
describe('Request references (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gives every response a short random reference', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(first.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('leaves refusals and bad requests answered as before', async () => {
    const signedOut = await app.inject({ method: 'GET', url: '/api/v1/customers' });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.json()).toMatchObject({ statusCode: 401 });
    expect(signedOut.json()).not.toHaveProperty('reference');

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
  });
});
