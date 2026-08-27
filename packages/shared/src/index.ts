import { z } from 'zod';

/**
 * Shared API contracts.
 *
 * Both the API (which produces these shapes) and the web client (which
 * consumes them) import from here. A breaking change to a response shape
 * therefore becomes a compile error in every consumer, rather than a runtime
 * surprise discovered in the browser.
 *
 * Contracts are defined as Zod schemas rather than bare TypeScript types so
 * the same definition can validate at runtime as well as check at build time.
 */

export const API_VERSION = 'v1' as const;

export const healthStatusSchema = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyStatusSchema = z.enum(['connected', 'disconnected']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string(),
  environment: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  dependencies: z.object({
    database: z.object({
      status: dependencyStatusSchema,
      latencyMs: z.number().nonnegative().nullable(),
      error: z.string().nullable(),
    }),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
