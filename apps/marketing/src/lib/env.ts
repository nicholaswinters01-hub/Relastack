import { z } from 'zod';

/**
 * Configuration for the marketing site.
 *
 * Validated once, here, rather than read ad hoc — the same discipline
 * `packages/config` applies to the API. It is deliberately NOT that package:
 * loading it would demand DATABASE_URL and a session secret, and the marketing
 * site has no database and no sessions. Requiring the product's configuration
 * to render a landing page would be exactly the coupling this app exists to
 * avoid.
 */

const schema = z.object({
  /**
   * Which email service holds the list.
   *
   * `log` is the default so the form works end to end with no account and no
   * key — it records the signup in the server log and returns success. That
   * makes local development and a demo possible without handing an address to
   * a third party, and it means a missing key in production degrades to
   * "captured nowhere" rather than a 500 in a visitor's face.
   */
  WAITLIST_PROVIDER: z
    .enum(['log', 'postgres', 'buttondown', 'convertkit', 'resend'])
    .default('log'),

  /** Secret. Server-side only — never prefixed NEXT_PUBLIC. */
  WAITLIST_API_KEY: z.string().optional(),

  /** ConvertKit needs a form id; Resend needs an audience id. */
  WAITLIST_LIST_ID: z.string().optional(),

  /**
   * Postgres connection string, for the `postgres` provider.
   *
   * A plain connection string rather than a vendor SDK, so the same code runs
   * against Neon today and against your own database later. Moving hosts is
   * changing this one value.
   */
  DATABASE_URL: z.string().optional(),
});

export type MarketingEnv = z.infer<typeof schema>;

let cached: MarketingEnv | null = null;

export function loadEnv(): MarketingEnv {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new Error(`Marketing configuration is invalid — ${detail}`);
  }

  // A provider missing the thing it needs would fail on the first real signup,
  // in front of a visitor. Better to say so at startup.
  const { WAITLIST_PROVIDER, WAITLIST_API_KEY, DATABASE_URL } = parsed.data;

  if (WAITLIST_PROVIDER === 'postgres' && !DATABASE_URL) {
    throw new Error('WAITLIST_PROVIDER is "postgres" but DATABASE_URL is not set');
  }

  if (!['log', 'postgres'].includes(WAITLIST_PROVIDER) && !WAITLIST_API_KEY) {
    throw new Error(`WAITLIST_PROVIDER is "${WAITLIST_PROVIDER}" but WAITLIST_API_KEY is not set`);
  }

  cached = parsed.data;

  return cached;
}
