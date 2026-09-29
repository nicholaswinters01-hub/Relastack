import Link from 'next/link';
import type { Metadata } from 'next';
import { BRAND, LEGAL_UPDATED } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Terms — ${BRAND.productName}`,
};

/**
 * The terms of service for the app.
 *
 * NOT LEGAL ADVICE and not reviewed by a lawyer; a plain-language starting
 * point written for the invite-only research period. The promises in it must
 * stay true of the product — above all that a lapsed account turns read-only
 * rather than being locked or deleted (CLAUDE.md rule 13).
 */
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <p className="text-sm">
        <Link href="/" className="underline underline-offset-4">
          Back
        </Link>
      </p>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Terms of service</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        The agreement between your business and {BRAND.legalEntity} for using {BRAND.productName}.
        Written to be read, not skimmed past.
      </p>

      <div className="mt-10 flex flex-col gap-8">
        <Section title="Early access">
          {BRAND.productName} is in early access, by invitation. Features will change, some will be
          added and some may be removed, and there may be interruptions while we work. We will tell
          you about changes that affect how you work before they happen where we can.
        </Section>

        <Section title="Your account">
          Whoever creates the account does so for their business and confirms they may. Keep
          passwords to yourselves. The business is responsible for the people it invites and for
          what they do in the account, and can remove them at any time.
        </Section>

        <Section title="Your records are yours">
          Everything your business puts into {BRAND.productName} stays yours. You let us store and
          process it only to run the service for you — never to sell, advertise with, or use for
          anyone else. You can delete it, download your customers, contacts and notes at any time,
          and we will give you a copy of anything else whenever you ask. How we handle it is set out
          in the{' '}
          <Link href="/privacy" className="underline underline-offset-4">
            privacy notice
          </Link>
          .
        </Section>

        <Section title="Your customers">
          When you keep records about your own customers, you are responsible for having the right
          to keep them and for telling your customers what you do with them. Contracts you send for
          signature are between you and your customer; we are not a party to them.
        </Section>

        <Section title="Records the law requires of you">
          Tools such as pesticide application records and customer sign-offs help you keep records,
          but they are not legal or regulatory advice. You remain responsible for meeting the rules
          that apply to your trade and your area.
        </Section>

        <Section title="Connected services">
          If you connect another service, such as DocuSign, its own terms apply to your use of it.
          You can disconnect at any time from Settings.
        </Section>

        <Section title="Fair use">
          Do not use {BRAND.productName} to break the law, send spam, store anything you have no
          right to hold, or try to get into another business&apos;s account or around our security.
          We may suspend an account that does, and will tell you why.
        </Section>

        <Section title="Paying">
          Plans and prices are the ones shown when you choose them. A trial ends on the date shown
          in the app. If a payment is missed, the account becomes read-only after a grace period:
          you can still see and download everything, and paying restores it. We do not lock you out
          of your own records, and we do not delete them for non-payment without telling you first.
        </Section>

        <Section title="Leaving">
          You can stop at any time: download your records, or ask us for a copy, then ask us to
          close the account. We may end these terms with 30 days&apos; notice, and will give you a
          copy of your records before we do.
        </Section>

        <Section title="What we promise, and what we cannot">
          We will run {BRAND.productName} with care and keep your records safe. But it is provided
          as it is, without guarantees that it will always be available or free of mistakes. As far
          as the law allows, we are not liable for indirect losses such as lost profit, and our
          total liability is limited to what you paid us in the twelve months before the claim.
        </Section>

        <Section title="Changes to these terms">
          If we change these terms in a way that matters, we will tell account owners by email and
          in the app before the change takes effect.
        </Section>

        <Section title="Who we are">
          {BRAND.productName} is run by {BRAND.legalEntity}. Questions go to {BRAND.contactEmail}.
          These terms are governed by the law of {BRAND.jurisdiction}.
        </Section>
      </div>

      <p className="mt-12 border-t border-[var(--color-line)] pt-6 text-xs text-[var(--color-muted)]">
        Last updated {LEGAL_UPDATED}.
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
