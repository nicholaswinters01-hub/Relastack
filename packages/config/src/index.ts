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

/**
 * Keys that encrypt the grants businesses give RelaStack to act in other
 * services: "1:<base64>,2:<base64>". Each is 32 random bytes. The highest
 * version encrypts; every listed version decrypts, so a key can be rotated by
 * adding the next one, re-encrypting, then dropping the old.
 */
const integrationKeys = z.string().transform((value, context) => {
  const keys = new Map<number, Buffer>();
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^(\d+):([A-Za-z0-9+/=_-]+)$/.exec(entry);
    const key = match ? Buffer.from(match[2]!, 'base64') : null;
    if (!match || !key || key.length !== 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each key must be "<version>:<32 bytes, base64>"',
      });
      return z.NEVER;
    }
    keys.set(Number(match[1]), key);
  }
  if (keys.size === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Give at least one key' });
    return z.NEVER;
  }
  return keys;
});

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

    /**
     * Requests per minute allowed per person (per IP) against general endpoints.
     *
     * Every page is built from several API calls the web tier makes on the
     * person's behalf (the navigation alone makes five), and open windows
     * refresh one another. 120 was reachable by one busy person on two
     * monitors. Sign-in and sign-up keep their own, much smaller, limits.
     */
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(300),

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

    /** Told whenever a business opens a help request, so nobody has to watch the console. */
    SUPPORT_NOTIFY_EMAIL: z.string().email().default('hello@relastack.com'),

    /** Where links in email point. No trailing slash. */
    APP_URL: z.string().default('http://localhost:3000'),

    /**
     * How often background work runs unprompted, in seconds: the sweeps, and
     * the fallback drain for notifications a nudge missed. New events are
     * delivered within seconds regardless; this is only the safety net.
     *
     * Deliberately long. Hosted Postgres that sleeps when idle only sleeps if
     * nothing wakes it, and a short interval would keep it awake for good.
     *
     * Zero disables all background delivery, which is what the test suite
     * uses so that a timer cannot race the assertions.
     */
    DISPATCH_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(3600),

    // --- Deployment -------------------------------------------------------
    /**
     * Shared with the web tier, which sends it on every request.
     *
     * When set, the API answers nothing else (health/live aside) — and it is
     * the only reason the client IP the web tier reports can be believed. Every
     * request reaches the API via the web tier's servers, so without a trusted
     * IP every user shares a handful of addresses and one busy user rate-limits
     * everyone. Required in production.
     */
    INTERNAL_API_SECRET: z
      .string()
      .min(32, 'INTERNAL_API_SECRET must be at least 32 characters')
      .optional(),

    /**
     * Required to register a new business, when set. Invitations to an existing
     * business never need it: the invitation link is the authorization.
     */
    SIGNUP_ACCESS_CODE: z
      .string()
      .min(8, 'SIGNUP_ACCESS_CODE must be at least 8 characters')
      .optional(),

    /** Production must either set SIGNUP_ACCESS_CODE or say this explicitly. */
    SIGNUP_OPEN: booleanFromString.default(false),

    /**
     * Customers choosing a plan, and the simulated billing events, on their own.
     *
     * Both stand in for a payment provider and both make a business "paying"
     * without any money changing hands. Until Phase 18 connects a provider,
     * payments are recorded by staff, so production refuses these outright.
     * Defaults to on everywhere else, so the lapse-and-recover path can still
     * be walked through locally.
     */
    BILLING_SIMULATION: booleanFromString.optional(),

    // --- Connected apps (Phase 11a) ---------------------------------------
    /**
     * Encrypts every OAuth grant a business gives RelaStack. Never stored in
     * the database, which is the point: a copy of the database alone reveals
     * no one's DocuSign. Without it, no business can connect anything.
     */
    INTEGRATION_TOKEN_KEYS: integrationKeys.optional(),

    /** DocuSign app ("integration key") credentials. Unset: DocuSign is not offered. */
    DOCUSIGN_CLIENT_ID: z.string().min(1).optional(),
    DOCUSIGN_CLIENT_SECRET: z.string().min(1).optional(),
    /** DocuSign's test ("demo") environment until the app passes its go-live review. */
    DOCUSIGN_ENVIRONMENT: z.enum(['demo', 'production']).default('demo'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.INTERNAL_API_SECRET !== undefined, {
    message: 'INTERNAL_API_SECRET must be set when NODE_ENV=production',
    path: ['INTERNAL_API_SECRET'],
  })
  // Fails closed: forgetting the code in production must not quietly open
  // sign-up to anyone who finds the site.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' || env.SIGNUP_OPEN || env.SIGNUP_ACCESS_CODE !== undefined,
    {
      message:
        'Set SIGNUP_ACCESS_CODE, or SIGNUP_OPEN=true to allow anyone to register, when NODE_ENV=production',
      path: ['SIGNUP_ACCESS_CODE'],
    },
  )
  // A production deployment serving session cookies over plaintext HTTP would
  // expose every session to anyone on the network path. Refuse to start.
  .refine((env) => env.NODE_ENV !== 'production' || env.BILLING_SIMULATION !== true, {
    message:
      'BILLING_SIMULATION cannot be true when NODE_ENV=production: it lets a business mark itself as paid',
    path: ['BILLING_SIMULATION'],
  })
  // A provider with nowhere safe to keep what it grants must not be offered.
  .refine(
    (env) =>
      (env.DOCUSIGN_CLIENT_ID === undefined && env.DOCUSIGN_CLIENT_SECRET === undefined) ||
      (env.DOCUSIGN_CLIENT_ID !== undefined &&
        env.DOCUSIGN_CLIENT_SECRET !== undefined &&
        env.INTEGRATION_TOKEN_KEYS !== undefined),
    {
      message:
        'DOCUSIGN_CLIENT_ID and DOCUSIGN_CLIENT_SECRET go together, and need INTEGRATION_TOKEN_KEYS',
      path: ['DOCUSIGN_CLIENT_ID'],
    },
  )
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

/** Whether customers may change plan and simulate payments themselves. Never in production. */
export const billingSimulationEnabled = (env: ServerEnv): boolean =>
  env.NODE_ENV !== 'production' && env.BILLING_SIMULATION !== false;
