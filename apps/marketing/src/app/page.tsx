import Link from 'next/link';
import { WaitlistForm } from '@/components/waitlist-form';
import { Wordmark } from '@/components/wordmark';
import { BRAND } from '@/lib/brand';

/**
 * The landing page.
 *
 * Everything claimed here is a claim about what is being built, not about
 * what exists today — there are no customers yet, so there are no numbers, no
 * logos and no testimonials on this page. Inventing them is the one thing that
 * would make the rest of it untrustworthy.
 */

const MODULES = [
  { name: 'Customers', body: 'Leads, customers, contacts, notes and history in one place.' },
  { name: 'Scheduling', body: 'Jobs, availability and calendars across every crew.' },
  { name: 'Staff', body: 'Who works where, what they can see, and what they can change.' },
  { name: 'Inventory', body: 'Stock and equipment, tracked per location.' },
  { name: 'Reporting', body: 'What is actually happening, without exporting to a spreadsheet.' },
  { name: 'Automation', body: 'When this happens, do that. Without writing anything.' },
];

interface Props {
  /**
   * `?error=1` comes back from a form post that failed without JavaScript.
   * Only ever a flag — the address that was typed is never put in the URL.
   */
  searchParams: Promise<{ error?: string }>;
}

export default async function HomePage({ searchParams }: Props) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-3xl px-6 py-20 sm:py-28">
      {/* ------------------------------------------------------------- */}
      <header>
        <div className="flex flex-wrap items-baseline gap-3">
          <Wordmark className="text-2xl" />
          <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-muted)]">
            in development
          </span>
        </div>

        <h1 className="mt-8 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Business software, built around you.
        </h1>

        <p className="mt-5 text-lg leading-relaxed text-[var(--color-muted)]">
          Most small businesses end up with five tools that do not talk to each other, or one that
          was clearly built for somebody else&apos;s trade. {BRAND.productName} is one system you
          turn on a piece at a time — customers, scheduling, staff, stock — so it fits how you
          already work instead of the other way round.
        </p>
      </header>

      {/* ------------------------------------------------------------- */}
      <section className="mt-12">
        {error && (
          <p className="mb-4 rounded-lg border border-[var(--color-bad)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
            That did not go through. Check the address and that the box is ticked, then try again.
          </p>
        )}

        <WaitlistForm />
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          No launch date yet. We will not email you about anything else, and we will not pass your
          address on.{' '}
          <Link href="/privacy" className="underline underline-offset-4">
            How we handle your data
          </Link>
          .
        </p>
      </section>

      {/* ------------------------------------------------------------- */}
      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight">
          Priced per location. Users are free.
        </h2>
        <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
          Per-seat pricing quietly punishes you for hiring. It is why businesses share logins, why
          the office manager never gets an account, and why nobody trusts who did what. We charge
          for the places you operate from, which is the thing that actually reflects the size of a
          business.
        </p>
        <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
          Put every single person on it. Seasonal staff, the apprentice, your accountant. It costs
          the same.
        </p>
      </section>

      {/* ------------------------------------------------------------- */}
      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Turn on what you need.</h2>
        <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
          A landscaping firm and a plumbing outfit need different things, and neither needs all of
          it on day one. Every part is a module you switch on when it becomes useful — and switch
          off again without losing anything you put into it.
        </p>

        <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-2">
          {MODULES.map((module) => (
            <div key={module.name} className="bg-[var(--color-surface)] p-5">
              <h3 className="font-semibold">{module.name}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">
                {module.body}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Being built in order. Customers first.
        </p>
      </section>

      {/* ------------------------------------------------------------- */}
      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Your data stays yours.</h2>
        <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
          Every business on {BRAND.productName} is separated at the database level, not just in the
          interface — one company cannot read another&apos;s records even if the software asks it
          to. Staff see the locations they work at and nothing else.
        </p>
        <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
          And if you ever stop paying, the account becomes read-only rather than locked. Your
          customer list, your history, your notes — still there, still exportable. Holding a
          business&apos;s own records hostage is not a retention strategy.
        </p>
      </section>

      {/* ------------------------------------------------------------- */}
      <section className="mt-20 rounded-2xl border border-[var(--color-line)] p-6">
        <h2 className="text-lg font-semibold">Where this is up to</h2>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
          Being built in the open, one piece at a time. Accounts, locations, staff permissions,
          billing and the customer records are working. Scheduling is next. There is no launch date
          and no trial to sign up for yet — the waitlist is how you hear when there is.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
          If you run a business like this and want a say in what gets built, say so in the box
          above. Early on, that is worth more than any roadmap.
        </p>
      </section>

      {/* ------------------------------------------------------------- */}
      <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-line)] pt-8 text-sm text-[var(--color-muted)]">
        <span>
          © {new Date().getFullYear()} {BRAND.legalEntity}
        </span>
        <Link href="/privacy" className="underline underline-offset-4">
          Privacy
        </Link>
      </footer>
    </main>
  );
}
