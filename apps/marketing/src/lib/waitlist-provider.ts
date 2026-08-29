import { loadEnv } from './env';
import { subscribeToPostgres } from './waitlist-postgres';
import type { WaitlistProvider as Provider } from './waitlist-types';

/**
 * An adapter over wherever the list is kept.
 *
 * The same rule the working agreement sets for payments: do not scatter
 * vendor-specific logic through the application. Every destination sits behind
 * this one interface, so changing where signups go is one environment
 * variable, not a search across the codebase.
 *
 * It has already earned itself. The first choice here was an email service
 * whose API turned out to sit behind a paid plan; switching to a database we
 * own cost one new file and one line in the registry below, and not a single
 * change to the form, the route or the page.
 *
 * `postgres` is the current destination: signups land in a table shaped like a
 * CRM lead, so they can be imported as real leads once the product is
 * deployed. The email services remain wired up for when there is a list worth
 * mailing.
 */

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

const postgres: Provider = { subscribe: subscribeToPostgres };

const PROVIDERS: Record<string, Provider> = {
  log: logProvider,
  postgres,
  buttondown,
  convertkit,
  resend,
};

export function waitlistProvider(): Provider {
  return PROVIDERS[loadEnv().WAITLIST_PROVIDER] ?? logProvider;
}
