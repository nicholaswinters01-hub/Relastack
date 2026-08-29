import { NextResponse } from 'next/server';
import { z } from 'zod';
import { waitlistProvider } from '@/lib/waitlist-provider';

/**
 * Waitlist signup.
 *
 * The only endpoint on the marketing site. It exists so the email provider's
 * API key stays on the server — a form posting straight to the provider would
 * put a usable key in every visitor's browser.
 */

export const runtime = 'nodejs';

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  note: z.string().trim().max(200).optional(),
  /**
   * Must be true. Consent that defaults to given is not consent, and it cannot
   * be obtained retroactively — a list built without it has to be
   * re-permissioned from scratch.
   */
  consent: z.literal(true, {
    errorMap: () => ({ message: 'Please tick the box to confirm you are happy to be emailed' }),
  }),
  /**
   * Honeypot. A real person never sees this field, so anything in it came from
   * something automated filling every input on the page.
   *
   * Deliberately NOT constrained here. Rejecting it in the schema returns a
   * validation error naming the field, which tells whoever wrote the bot
   * exactly which input to stop filling. It is checked in the handler instead,
   * where the answer is indistinguishable from success.
   */
  company: z.string().max(200).optional(),
});

/**
 * A crude per-address limiter.
 *
 * In memory, so it resets on deploy and does not span instances. That is fine
 * for what it defends against — someone hammering the form in a loop — and a
 * shared store would be real infrastructure for a landing page. The provider
 * deduplicates anyway.
 */
const RECENT = new Map<string, number>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;

function tooMany(key: string): boolean {
  const now = Date.now();

  for (const [entry, time] of RECENT) {
    if (now - time > WINDOW_MS) RECENT.delete(entry);
  }

  const count = [...RECENT.entries()].filter(
    ([entry, time]) => entry.startsWith(`${key}:`) && now - time < WINDOW_MS,
  ).length;

  if (count >= MAX_PER_WINDOW) return true;

  RECENT.set(`${key}:${now}`, now);

  return false;
}

/**
 * One message for every outcome that is not the visitor's fault.
 *
 * Saying "you are already on the list" would turn the form into an oracle for
 * checking whether a given address has signed up. The friendliness is not
 * worth handing that out, and the visitor cannot act on the difference anyway.
 */
const SUCCESS = { message: "You're on the list. We'll email you when there's something to see." };

/**
 * Reads either a JSON body or a plain form post.
 *
 * The form works without JavaScript, so the same endpoint has to accept what a
 * browser sends natively. Returning `browser: true` for the form-encoded case
 * lets the caller answer with a page rather than JSON — nobody wants to land
 * on a screenful of braces after clicking a button.
 */
async function readBody(request: Request): Promise<{ data: unknown; browser: boolean } | null> {
  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      return { data: await request.json(), browser: false };
    }

    const form = await request.formData();

    return {
      data: {
        email: form.get('email') ?? '',
        note: form.get('note') || undefined,
        // An unticked checkbox is absent from the payload entirely, so this
        // has to test for presence rather than for a value.
        consent: form.get('consent') !== null,
        company: form.get('company') ?? '',
      },
      browser: true,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readBody(request);

  if (!body) return NextResponse.json({ message: 'Malformed request' }, { status: 400 });

  const { browser } = body;

  /** JSON for the client component, a redirect for a plain form post. */
  const answer = (message: string, status: number, ok: boolean): NextResponse => {
    if (!browser) return NextResponse.json({ message }, { status });

    const url = new URL(ok ? '/thanks' : '/', request.url);
    // Only ever a short error CODE in the URL, never the address that was
    // typed. Putting the email here is exactly what the POST is avoiding.
    if (!ok) url.searchParams.set('error', '1');

    return NextResponse.redirect(url, 303);
  };

  const parsed = requestSchema.safeParse(body.data);

  if (!parsed.success) {
    return answer(parsed.error.issues[0]?.message ?? 'Check the form', 400, false);
  }

  // Bots get the same answer as anyone else. Telling them they were caught
  // only teaches whoever wrote them to stop filling the field.
  if (parsed.data.company) return answer(SUCCESS.message, 200, true);

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  if (tooMany(ip)) {
    return answer('That is a lot of signups. Try again in a minute.', 429, false);
  }

  const result = await waitlistProvider().subscribe({
    email: parsed.data.email,
    note: parsed.data.note,
    consentedAt: new Date().toISOString(),
  });

  if (!result.ok) {
    // Logged for us, generic for them. A visitor can do nothing with
    // "Buttondown responded 502", and the provider's name is not their problem.
    console.error('[waitlist] provider rejected signup', result.reason);

    return answer('Something went wrong at our end. Please try again shortly.', 502, false);
  }

  return answer(SUCCESS.message, 200, true);
}
