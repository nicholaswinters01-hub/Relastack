import Link from 'next/link';
import type { Metadata } from 'next';
import { BRAND, LEGAL_UPDATED } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Privacy — ${BRAND.productName}`,
};

/**
 * The privacy notice for the waitlist and the product.
 *
 * NOT LEGAL ADVICE and not reviewed by a lawyer. Every statement here has to
 * stay true of the code: the providers listed are the ones configured in
 * docs/deploy.md, and "staff never see your customers" is enforced by RLS
 * (no staff policy on customer-data tables). Change the system, change this.
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
        What {BRAND.productName} keeps, why, and who else touches it. There are two parts: the
        waitlist on this site, and the app at {BRAND.appUrl.replace('https://', '')}.
      </p>

      <h2 className="mt-12 text-xl font-semibold tracking-tight">The waitlist</h2>
      <div className="mt-6 flex flex-col gap-8">
        <Section title="What we collect">
          Your email address. Optionally, whatever you typed in the &ldquo;what do you do&rdquo;
          box. The date you gave consent. Nothing else — there are no analytics, no advertising
          pixels and no third-party cookies on this site.
        </Section>

        <Section title="Why">
          To email you when {BRAND.productName} is ready for people to try, and to understand what
          kinds of business are interested so the right things get built first. We will not email
          you about anything else.
        </Section>

        <Section title="Who else sees it">
          Your address is stored with the email service we use to send the list. They process it on
          our instructions and do not use it for anything of their own. We do not sell, rent or
          share your address with anybody else.
        </Section>

        <Section title="How long we keep it">
          Until you unsubscribe, or until the waitlist is wound up after launch — whichever comes
          first. Every email includes a one-click unsubscribe link.
        </Section>

        <Section title="Legal basis">
          Consent, which you gave by ticking the box on the form. If you did not tick it, you are
          not on the list.
        </Section>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">The app</h2>
      <div className="mt-6 flex flex-col gap-8">
        <Section title="Two kinds of information">
          Information about <em>you</em> as a person who signs in, which we are responsible for. And
          the records a business keeps in {BRAND.productName} about <em>its own</em> customers —
          names, addresses, notes, jobs, signatures. That information belongs to the business. We
          hold it on the business&apos;s behalf and use it only to run the service for them; the
          business decides what goes in and is responsible for telling its customers.
        </Section>

        <Section title="What we keep about you">
          Your name, email address and a scrambled form of your password (we cannot read it back).
          The business you belong to, your role there and the locations you work at. When you sign
          in, the address your connection came from and the kind of browser, so you can see where
          you are signed in and so we can spot misuse. Messages you send us through the help desk.
          For a business account: its plan, and payments we have recorded.
        </Section>

        <Section title="Cookies">
          One cookie, which keeps you signed in. No analytics, advertising or tracking cookies.
        </Section>

        <Section title="Who can see a business's records">
          The people that business invites, limited by the roles and locations it gives them. Our
          own staff can see account information — the business&apos;s name, plan, locations and
          people — to help and bill you, and every look is logged. They cannot see a business&apos;s
          customers, jobs, tasks or notes; the database refuses it, not just the screen.
        </Section>

        <Section title="Services we use">
          <>
            {BRAND.productName} runs on a small number of providers, each holding data only to do
            its part:
            <Providers />
            All are in the United States. If a business connects its own DocuSign account, the
            documents it sends for signature go to DocuSign under that business&apos;s own agreement
            with them; we keep only the envelope&apos;s status, who it went to and when. Connection
            credentials are encrypted and the business can disconnect at any time.
          </>
        </Section>

        <Section title="What we never do">
          Sell data, show advertising, or use a business&apos;s records for anything other than
          running {BRAND.productName} for that business.
        </Section>

        <Section title="How long we keep it">
          For as long as the account is open. A business can delete its own customer records. If a
          business asks us to close its account, we delete its records, except anything the law
          requires us to keep, such as payment records. Our database provider keeps short-lived
          backups for recovery, and deleted information leaves them as they expire.
        </Section>

        <Section title="Keeping it safe">
          Connections are encrypted. Each business&apos;s records are kept apart by the database
          itself, so one business cannot reach another&apos;s. Passwords are stored only in
          scrambled form, and credentials for connected services are encrypted.
        </Section>

        <Section title="Children">
          {BRAND.productName} is business software and is not meant for anyone under 16.
        </Section>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Both</h2>
      <div className="mt-6 flex flex-col gap-8">
        <Section title="Your rights">
          You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to
          delete it — write to {BRAND.contactEmail}. If your question is about a business&apos;s
          records of you as its customer, ask that business first; we will help it answer.
        </Section>

        <Section title="Changes">
          If we change this notice in a way that matters, we will say so in the app and email
          account owners before it takes effect.
        </Section>

        <Section title="Who we are">
          {BRAND.legalEntity} runs {BRAND.productName}. Questions, complaints or requests go to{' '}
          {BRAND.contactEmail}. This notice is governed by the law of {BRAND.jurisdiction}. See also
          the{' '}
          <Link href="/terms" className="underline underline-offset-4">
            terms of service
          </Link>
          .
        </Section>
      </div>

      <p className="mt-12 border-t border-[var(--color-line)] pt-6 text-xs text-[var(--color-muted)]">
        Last updated {LEGAL_UPDATED}.
      </p>
    </main>
  );
}

const PROVIDERS = [
  ['Neon', 'the database'],
  ['Render', 'the servers that run the app'],
  ['Vercel', 'the website and the pages you see'],
  ['Resend', 'sending email, such as invitations and notifications'],
] as const;

function Providers() {
  return (
    <ul className="my-3 list-disc pl-5">
      {PROVIDERS.map(([name, role]) => (
        <li key={name}>
          <span className="text-[var(--color-ink)]">{name}</span> — {role}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-2 leading-relaxed text-[var(--color-muted)]">{children}</div>
    </section>
  );
}
