import { z } from 'zod';

/**
 * Health contract. Consumed by the API (which produces it) and the web client
 * (which renders it), so a change to the shape breaks compilation in both.
 */

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
