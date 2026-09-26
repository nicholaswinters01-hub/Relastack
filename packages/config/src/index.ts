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

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /**
     * Privileged connection. Owns the schema and runs migrations.
     *
     * This role is a superuser and therefore BYPASSES row-level security.
     * It must never serve application requests — use DATABASE_URL_APP.
     */
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'DATABASE_URL must be a PostgreSQL connection string',
      ),

    /**
     * Application connection. Unprivileged, and subject to every RLS policy.
     *
     * Every query serving a request goes through this. Defaults to
     * DATABASE_URL only so that tooling which needs no isolation still works;
     * production is forbidden from that below, because running the app as the
     * migration role would silently disable tenant isolation entirely.
     */
    DATABASE_URL_APP: z
      .string()
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value.startsWith('postgresql://') ||
          value.startsWith('postgres://'),
        'DATABASE_URL_APP must be a PostgreSQL connection string',
      ),

    API_PORT: z.coerce.number().int().positive().max(65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),

    CORS_ORIGINS: commaSeparatedList.default('http://localhost:3000'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- Sessions ---------------------------------------------------------
    /** How long a session remains valid without renewal. */
    SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(7),

    /**
     * Sets the `Secure` flag on the session cookie, restricting it to HTTPS.
     * Must be true in production; defaults false so local HTTP development
     * works without ceremony. Enforced below.
     */
    COOKIE_SECURE: booleanFromString.default(false),

    /** Cookie domain. Leave unset for host-only cookies (the safer default). */
    COOKIE_DOMAIN: z.string().optional(),

    // --- Rate limiting ----------------------------------------------------
    /**
     * Master switch. Defaults on, and production is forbidden from turning it
     * off below — an unthrottled login endpoint is both a credential-stuffing
     * target and, because Argon2 is deliberately expensive, a DoS vector.
     *
     * Exists for load testing and for suites that issue far more requests than
     * a real user would.
     */
    RATE_LIMIT_ENABLED: booleanFromString.default(true),

    /** Requests per minute allowed per IP against general endpoints. */
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(120),

    /** Login attempts allowed per minute per IP. Deliberately small. */
    RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(5),

    /** Registrations allowed per hour per IP. */
    RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().positive().default(10),

    // --- Account lockout --------------------------------------------------
    /**
     * Consecutive failed sign-ins before an account is locked.
     *
     * Separate from rate limiting, which counts per IP and is therefore
     * defeated by an attacker rotating addresses — the shape credential
     * stuffing actually takes.
     */
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().max(100).default(8),

    /**
     * How long a lock lasts.
     *
     * Deliberately minutes rather than "until an administrator clears it".
     * A permanent lock hands an attacker a denial-of-service: knowing someone's
     * email would be enough to keep them out indefinitely. A short window stops
     * automated guessing while leaving a real user only briefly inconvenienced.
     */
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

    /**
     * Where outbound email goes.
     *
     * `log` is the default so the whole notification path runs end to end with
     * no account and no key — and so a misconfigured deploy writes the message
     * to the log rather than losing it silently.
     */
    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    EMAIL_API_KEY: z.string().optional(),

    /** The From address. Must be on a domain the provider has verified. */
    EMAIL_FROM: z.string().default('Relastack <hello@relastack.com>'),

    /**
     * A physical postal address, printed in the footer of every message.
     *
     * Required by CAN-SPAM for commercial email in the US, which is the market.
     * Kept in configuration rather than a template so it is impossible to send
     * a batch that quietly omits it.
     */
    EMAIL_POSTAL_ADDRESS: z.string().default(''),

    /** Where links in email point. No trailing slash. */
    APP_URL: z.string().default('http://localhost:3000'),

    /**
     * How often the outbox is drained, in seconds.
     *
     * Zero disables the dispatcher entirely, which is what the test suite uses
     * so that a background timer cannot race the assertions.
     */
    DISPATCH_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(10),
  })
  // A production deployment serving session cookies over plaintext HTTP would
  // expose every session to anyone on the network path. Refuse to start.
  .refine((env) => env.NODE_ENV !== 'production' || env.COOKIE_SECURE, {
    message: 'COOKIE_SECURE must be true when NODE_ENV=production',
    path: ['COOKIE_SECURE'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.RATE_LIMIT_ENABLED, {
    message: 'RATE_LIMIT_ENABLED must be true when NODE_ENV=production',
    path: ['RATE_LIMIT_ENABLED'],
  })
  // Serving requests as the migration role would leave every RLS policy in
  // place but inert, because superusers bypass row-level security. The system
  // would look correctly configured and isolate nothing.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (env.DATABASE_URL_APP !== undefined && env.DATABASE_URL_APP !== env.DATABASE_URL),
    {
      message:
        'DATABASE_URL_APP must be set and different from DATABASE_URL when NODE_ENV=production ' +
        '(the migration role bypasses row-level security)',
      path: ['DATABASE_URL_APP'],
    },
  );

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
