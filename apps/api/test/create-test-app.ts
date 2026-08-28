import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPrismaClient, type PrismaClient } from '@platform/db';
import { AppModule } from '../src/app.module';
import { fastifyCookiePlugin } from '../src/common/fastify-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

export interface TestApp {
  app: NestFastifyApplication;
  prisma: PrismaService;
}

/**
 * A client connected as the MIGRATION role, which bypasses row-level security.
 *
 * Test fixtures need this. `PrismaService` now connects as the unprivileged
 * application role, so a fixture using it would be subject to the very
 * policies under test: cross-tenant setup and teardown would silently affect
 * zero rows, and the suite would pass while proving nothing.
 *
 * Use ONLY for arranging and cleaning up test data. Every assertion about what
 * a tenant can see must go through the application, or through a client
 * connected as the app role.
 */
export function createPrivilegedTestClient(): PrismaClient {
  const url = process.env.DATABASE_URL;

  if (!url) throw new Error('DATABASE_URL must be set for test fixtures');

  return createPrismaClient({ databaseUrl: url, logErrors: false });
}

/**
 * Boot the real application for end-to-end testing.
 *
 * Mirrors main.ts in the ways that matter to behaviour — the cookie plugin and
 * the global route prefix. Helmet and CORS are omitted: they add response
 * headers but change no application logic.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

  await app.getHttpAdapter().getInstance().register(fastifyCookiePlugin);
  app.setGlobalPrefix('api/v1');

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return { app, prisma: moduleRef.get(PrismaService) };
}
