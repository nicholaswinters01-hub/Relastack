import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// Load the repository-root .env before anything reads configuration.
// Done here, at the process entry point, so that importing any application
// module never has the side effect of touching the filesystem.
loadDotenv({ path: resolve(__dirname, '../../../.env') });

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { loadServerEnv } from '@platform/config';
import { AppModule } from './app.module';
import { fastifyCookiePlugin } from './common/fastify-cookie';

async function bootstrap(): Promise<void> {
  // Validate configuration before building the application. A misconfigured
  // process should fail here, not halfway through dependency injection.
  const env = loadServerEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { logger: logLevelsFor(env.LOG_LEVEL) },
  );

  // Security headers.
  //
  // The API serves JSON and nothing else — no HTML, no scripts, no styles, no
  // images. So its Content-Security-Policy can be the strictest one there is:
  // deny everything. If a response ever did manage to render as a document
  // (a reflected-content bug, a browser sniffing the type), the policy leaves
  // nothing for an attacker to execute.
  //
  // frame-ancestors 'none' additionally forbids embedding the API in a frame,
  // which is the clickjacking defence that X-Frame-Options only approximates.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // Browsers must not guess a content type. Combined with the CSP above this
    // closes the "JSON response rendered as HTML" class of bug.
    noSniff: true,
    // Keeps the API out of a cross-origin page's process.
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // Parses incoming Cookie headers and adds reply.setCookie/clearCookie.
  // No `secret` is configured: session tokens are 256-bit random values whose
  // hash is checked against the database, so a signature would add nothing —
  // an attacker cannot forge a token that exists in the sessions table.
  // See common/fastify-cookie.ts for why the plugin is imported via a helper.
  await app.getHttpAdapter().getInstance().register(fastifyCookiePlugin);

  // Explicit allow-list. `credentials: true` is required because sessions
  // (Phase 1) will be carried in httpOnly cookies.
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

  // NOTE: no global ValidationPipe here. Nest's built-in pipe requires
  // class-validator, and this project validates with Zod instead (see
  // packages/shared) — carrying two validation libraries would mean two places
  // to define every rule and two places for them to drift apart. Phase 1
  // introduces a Zod-backed pipe alongside the first endpoints that accept a
  // request body. Phase 0 has none.

  // All routes are versioned from day one. Retrofitting a version prefix once
  // external websites and integrations depend on the API is a breaking change.
  app.setGlobalPrefix('api/v1');

  app.enableShutdownHooks();

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://localhost:${env.API_PORT}/api/v1`);
  logger.log(`Environment: ${env.NODE_ENV}`);
}

function logLevelsFor(level: string) {
  const levels = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  const cutoff: Record<string, number> = {
    fatal: 1,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
  };
  return levels.slice(0, cutoff[level] ?? 3);
}

void bootstrap();
