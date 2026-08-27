import { z } from 'zod';

/**
 * Centralised, validated application configuration.
 *
 * Rationale (see docs/adr/0001): configuration is read and validated exactly
 * once, at process start. Application code receives a fully-typed object and
 * never touches `process.env` directly. A missing or malformed variable
 * crashes the process immediately with an actionable message, instead of
 * producing an `undefined` that surfaces as a confusing failure much later.
 */

const commaSeparatedList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().url()));

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'DATABASE_URL must be a PostgreSQL connection string',
    ),

  API_PORT: z.coerce.number().int().positive().max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),

  CORS_ORIGINS: commaSeparatedList.default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Thrown when environment validation fails. Carries a human-readable summary
 * of every problem found, not just the first one.
 */
export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}\n\n` +
        'Check your .env file against .env.example.',
    );
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate and parse server configuration.
 *
 * @param source Raw environment values. Defaults to `process.env`. Accepting
 *   an explicit source keeps this function pure and directly unit-testable.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }

  return result.data;
}

export const isProduction = (env: ServerEnv): boolean => env.NODE_ENV === 'production';
export const isTest = (env: ServerEnv): boolean => env.NODE_ENV === 'test';
