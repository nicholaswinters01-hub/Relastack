import { loadEnv } from './env';

/**
 * An adapter over whichever email service holds the list.
 *
 * The same rule the working agreement sets for payments: do not scatter
 * vendor-specific logic through the application. Every provider quirk is
 * behind this one interface, so swapping Buttondown for ConvertKit is one
 * function and an environment variable, not a search across the codebase.
 *
 * It matters more than it looks. A waitlist is the first thing built and the
 * last thing migrated; whichever service is picked today will almost certainly
 * not be the one sending mail in two years.
 */

export interface SubscribeInput {
  email: string;
  /** When the visitor ticked the consent box. Recorded, not inferred. */
  consentedAt: string;
  /** Free text, e.g. the trade they are in. Optional. */
  note?: string;
}

export type SubscribeResult =
  | { ok: true }
  /**
   * Already on the list. Reported separately so the caller can decide what to
   * say — the route deliberately does NOT pass this on to the visitor.
   */
  | { ok: true; duplicate: true }
  | { ok: false; reason: string };

interface Provider {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
}

/**
 * Development and fallback.
 *
 * Writes to the server log and reports success, so the whole form works with
 * no account and no key. Also what a misconfigured production deploy falls
 * back to, which loses the signup but does not show a visitor an error.
 */
const logProvider: Provider = {
  async subscribe(input) {
    console.info('[waitlist] signup', {
      email: input.email,
      consentedAt: input.consentedAt,
      note: input.note,
    });

    return { ok: true };
  },
};

const buttondown: Provider = {
  async subscribe(input) {
    const { WAITLIST_API_KEY } = loadEnv();

    const response = await fetch('https://api.buttondown.email/v1/subscribers', {
      method: 'POST',
      headers: {
        Authorization: `Token ${WAITLIST_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email_address: input.email,
        // Unactivated means Buttondown sends the confirmation and only adds
        // them once they click it. Double opt-in without building it.
        type: 'unactivated',
        notes: input.note,
        metadata: { consented_at: input.consentedAt },
      }),
    });

    if (response.ok) return { ok: true };

    // Buttondown answers 400 for an address already present.
    if (response.status === 400) {
      const body = await response.text();
      if (body.includes('already')) return { ok: true, duplicate: true };
    }

    return { ok: false, reason: `Buttondown responded ${response.status}` };
  },
};

const convertkit: Provider = {
  async subscribe(input) {
    const { WAITLIST_API_KEY, WAITLIST_LIST_ID } = loadEnv();

    if (!WAITLIST_LIST_ID) return { ok: false, reason: 'WAITLIST_LIST_ID is not set' };

    const response = await fetch(
      `https://api.convertkit.com/v3/forms/${WAITLIST_LIST_ID}/subscribe`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: WAITLIST_API_KEY,
          email: input.email,
          fields: { consented_at: input.consentedAt, note: input.note },
        }),
      },
    );

    // ConvertKit treats a repeat signup as success, so there is no duplicate
    // case to distinguish.
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `ConvertKit responded ${response.status}` };
  },
};

const resend: Provider = {
  async subscribe(input) {
    const { WAITLIST_API_KEY, WAITLIST_LIST_ID } = loadEnv();

    if (!WAITLIST_LIST_ID) return { ok: false, reason: 'WAITLIST_LIST_ID is not set' };

    const response = await fetch(`https://api.resend.com/audiences/${WAITLIST_LIST_ID}/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAITLIST_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: input.email, unsubscribed: false }),
    });

    // Resend audiences do NOT send a confirmation email of their own. If this
    // is the chosen provider, double opt-in has to be built separately before
    // launch — see the note in the README.
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `Resend responded ${response.status}` };
  },
};

const PROVIDERS: Record<string, Provider> = {
  log: logProvider,
  buttondown,
  convertkit,
  resend,
};

export function waitlistProvider(): Provider {
  return PROVIDERS[loadEnv().WAITLIST_PROVIDER] ?? logProvider;
}
