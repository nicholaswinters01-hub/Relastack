'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BillingSummary, Plan, Subscription } from '@platform/shared';

interface Props {
  subscription: Subscription;
  summary: BillingSummary;
  plans: Plan[];
  canManage: boolean;
}

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * Plan, price, and what a lapse means.
 *
 * Showing the plan is a courtesy. What actually stops a lapsed organization
 * writing is ReadOnlyGuard on the API, and what stops it using a module it has
 * not paid for is the entitlement guard — both asserted in the e2e suite by
 * calling the endpoints directly.
 */
export function BillingManager({ subscription, summary, plans, canManage }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);

    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.message ?? 'That did not work.');
        return;
      }

      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const isLapsed = subscription.accessLevel === 'read-only';
  const inGrace = subscription.status === 'PAST_DUE' && subscription.graceEndsAt;

  return (
    <div className="mt-8 flex flex-col gap-8">
      {/* --------------------------------------------------------------- */}
      {isLapsed && (
        <div className="rounded-xl border border-[var(--color-bad)] bg-[var(--color-surface)] p-5">
          <h2 className="font-semibold text-[var(--color-bad)]">This account is read-only</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {subscription.status === 'CANCELLED'
              ? 'Your subscription has ended. Everything you created is still here and you can still read and export it. Choose a plan below to start making changes again.'
              : 'Your subscription is not active. You can still see and export everything, but changes are paused until billing is up to date.'}
          </p>
        </div>
      )}

      {inGrace && (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="font-semibold">A payment did not go through</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Nothing has changed yet — you have full access until{' '}
            <strong>{day(subscription.graceEndsAt!)}</strong>. After that the account becomes
            read-only until the payment succeeds.
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {/* --------------------------------------------------------------- */}
      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold">{subscription.planName}</h2>
          <span
            className={`font-mono text-xs ${
              isLapsed ? 'text-[var(--color-bad)]' : 'text-[var(--color-ok)]'
            }`}
          >
            {subscription.status.toLowerCase().replace('_', ' ')}
          </span>
        </div>

        {subscription.trialEndsAt && subscription.status === 'TRIALING' && (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Your trial runs until {day(subscription.trialEndsAt)}.
          </p>
        )}

        <dl className="mt-5 flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Base</dt>
            <dd className="font-mono">{money(summary.basePriceCents)}</dd>
          </div>

          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">
              Locations — {summary.activeLocations} active, {summary.includedLocations} included
            </dt>
            <dd className="font-mono">{money(summary.locationChargeCents)}</dd>
          </div>

          {summary.addOnChargeCents > 0 && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Add-ons</dt>
              <dd className="font-mono">{money(summary.addOnChargeCents)}</dd>
            </div>
          )}

          <div className="mt-2 flex justify-between border-t border-[var(--color-line)] pt-3 font-semibold">
            <dt>Per month</dt>
            <dd className="font-mono">{money(summary.totalCents)}</dd>
          </div>
        </dl>

        {/* The commercial promise, stated where it is easiest to doubt. */}
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          {summary.userCount} {summary.userCount === 1 ? 'person has' : 'people have'} an account.
          Users are always free — you are billed by location.
        </p>
      </section>

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Plans
        </h2>

        <div className="mt-4 flex flex-col gap-3">
          {plans.map((plan) => {
            const current = plan.key === subscription.planKey;
            const tooManyLocations =
              plan.maxLocations !== null && summary.activeLocations > plan.maxLocations;

            return (
              <div
                key={plan.key}
                className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-[var(--color-surface)] p-5 ${
                  current ? 'border-[var(--color-ink)]' : 'border-[var(--color-line)]'
                }`}
              >
                <div className="min-w-64 flex-1">
                  <div className="flex items-baseline gap-2">
                    <h3 className="font-semibold">{plan.name}</h3>
                    {current && (
                      <span className="font-mono text-xs text-[var(--color-muted)]">current</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">{plan.description}</p>
                  <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">
                    {money(plan.basePriceCents)}/mo · {plan.includedLocations} location
                    {plan.includedLocations === 1 ? '' : 's'} included
                    {plan.perLocationPriceCents > 0 &&
                      ` · ${money(plan.perLocationPriceCents)} each after`}
                    {plan.maxLocations !== null && ` · max ${plan.maxLocations}`}
                  </p>

                  {tooManyLocations && (
                    <p className="mt-1 text-xs text-[var(--color-bad)]">
                      You have {summary.activeLocations} locations. Deactivate some first.
                    </p>
                  )}
                </div>

                {canManage && !current && (
                  <button
                    onClick={() => post('/api/v1/billing/plan', { planKey: plan.key }, plan.key)}
                    disabled={busy !== null || tooManyLocations}
                    className="rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
                  >
                    {busy === plan.key ? '…' : 'Choose'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {canManage && (
        <section className="rounded-xl border border-dashed border-[var(--color-line)] p-5">
          <h2 className="text-sm font-semibold">Simulate a billing event</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Stands in for payment-provider webhooks until Phase 18, so the lapse-and-recover path
            can be walked through by hand.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {(
              ['payment_failed', 'grace_expired', 'payment_succeeded', 'cancel', 'resume'] as const
            ).map((name) => (
              <button
                key={name}
                onClick={() => post('/api/v1/billing/events', { event: name }, name)}
                disabled={busy !== null}
                className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 font-mono text-xs disabled:opacity-50"
              >
                {busy === name ? '…' : name}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
