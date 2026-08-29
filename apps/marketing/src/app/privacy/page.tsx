import Link from 'next/link';
import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Privacy — ${BRAND.productName}`,
};

/**
 * The privacy notice for the waitlist.
 *
 * NOT LEGAL ADVICE and not reviewed by a lawyer. It describes accurately what
 * the signup form does, which is the necessary starting point, but the
 * placeholders in brand.ts must be replaced with a real entity and a monitored
 * address before this is published — a notice naming nobody gives a visitor
 * no one to exercise their rights against.
 *
 * It covers the WAITLIST only. The product itself will need its own notice
 * covering business data, sub-processors and retention.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <p className="text-sm">
        <Link href="/" className="underline underline-offset-4">
          Back
        </Link>
      </p>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        This covers the waitlist on this site. It is short because we collect very little.
      </p>

      <div className="mt-10 flex flex-col gap-8">
        <Section title="What we collect">
          Your email address. Optionally, whatever you typed in the &ldquo;what do you do&rdquo;
          box. The date you gave consent. Nothing else — there are no analytics, no advertising
          pixels and no third-party cookies on this site.
        </Section>

        <Section title="Why">
          To email you when {BRAND.productName} is ready for people to try, and to understand what
          kinds of business are interested so the right things get built first. That is the entire
          purpose. We will not email you about anything else.
        </Section>

        <Section title="Who else sees it">
          Your address is stored with the email service we use to send the list. They process it on
          our instructions and do not use it for anything of their own. We do not sell, rent or
          share your address with anybody else.
        </Section>

        <Section title="How long we keep it">
          Until you unsubscribe, or until the waitlist is wound up after launch — whichever comes
          first. Every email includes a one-click unsubscribe link, and unsubscribing removes you
          from the list.
        </Section>

        <Section title="Your rights">
          You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to
          delete it — write to {BRAND.contactEmail} and we will action it. You can withdraw consent
          at any time by unsubscribing; that does not affect anything already sent.
        </Section>

        <Section title="Legal basis">
          Consent, which you gave by ticking the box on the form. Not legitimate interest, and not a
          pre-ticked box: if you did not tick it, you are not on the list.
        </Section>

        <Section title="Who we are">
          {BRAND.legalEntity} is the data controller. Questions, complaints or requests go to{' '}
          {BRAND.contactEmail}. This notice is governed by the law of {BRAND.jurisdiction}.
        </Section>
      </div>

      <p className="mt-12 border-t border-[var(--color-line)] pt-6 text-xs text-[var(--color-muted)]">
        Last updated {new Date().toISOString().slice(0, 10)}.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 leading-relaxed text-[var(--color-muted)]">{children}</p>
    </section>
  );
}
