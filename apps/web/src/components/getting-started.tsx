'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SetupProgress } from '@platform/shared';

interface Step {
  key: keyof SetupProgress;
  title: string;
  why: string;
  href: string;
  action: string;
}

/**
 * "Get started", for whoever runs a new business.
 *
 * Each step is ticked from the account itself (see the setup endpoint), not by
 * the person, so it can't be ticked off by mistake. It goes away when every
 * step is done, or when hidden; hiding is remembered in this browser only.
 */
export function GettingStarted({
  organizationId,
  progress,
  crmOn,
  schedulingOn,
}: {
  organizationId: string;
  progress: SetupProgress;
  crmOn: boolean;
  schedulingOn: boolean;
}) {
  const storageKey = `rs-setup-hidden-${organizationId}`;
  const [hidden, setHidden] = useState(true);

  // Read after mounting: the server cannot see browser storage, and guessing
  // "shown" would flash the card at people who hid it.
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(storageKey) === '1');
    } catch {
      setHidden(false);
    }
  }, [storageKey]);

  const steps: Step[] = [
    {
      key: 'hasName',
      title: 'Add your name',
      why: 'So your team and customers see who you are, not an email address.',
      href: '/account',
      action: 'Your account',
    },
    {
      key: 'hasModules',
      title: 'Choose what you need',
      why: 'Switch on Customers, Scheduling and the rest. New accounts start with them off.',
      href: '/modules',
      action: 'Modules',
    },
    {
      key: 'hasLocation',
      title: 'Add your first location',
      why: 'Where you work from. Times on the schedule follow its time zone.',
      href: '/locations',
      action: 'Locations',
    },
    {
      key: 'hasTeammate',
      title: 'Invite someone on your team',
      why: 'Everyone is free: you are billed by location, never per person.',
      href: '/employees',
      action: 'Employees',
    },
    ...(crmOn
      ? [
          {
            key: 'hasCustomer' as const,
            title: 'Add a customer',
            why: 'Or a lead. Each gets an account number you can search for.',
            href: '/customers?new=1',
            action: 'New customer',
          },
        ]
      : []),
    ...(schedulingOn
      ? [
          {
            key: 'hasJob' as const,
            title: 'Book a job',
            why: 'Put work on the schedule and choose who is going.',
            href: '/schedule',
            action: 'Schedule',
          },
        ]
      : []),
  ];

  const done = steps.filter((step) => progress[step.key]).length;
  if (hidden || done === steps.length) return null;

  return (
    <section className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Get started</h2>
          <p className="text-sm text-[var(--color-muted)]">
            {done} of {steps.length} done
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(storageKey, '1');
            } catch {
              // Private windows: hidden until the next visit only.
            }
            setHidden(true);
          }}
          className="text-xs underline underline-offset-4"
        >
          Hide
        </button>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-canvas)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
      >
        <div
          className="h-full bg-[var(--color-ink)]"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>

      <ol className="mt-5 flex flex-col gap-3">
        {steps.map((step) => {
          const complete = progress[step.key];
          return (
            <li key={step.key} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                  complete
                    ? 'border-transparent bg-[var(--color-ok)] text-[var(--color-canvas)]'
                    : 'border-[var(--color-line)]'
                }`}
              >
                {complete ? '✓' : ''}
              </span>
              <div className="flex-1">
                <p
                  className={`text-sm font-medium ${complete ? 'text-[var(--color-muted)] line-through' : ''}`}
                >
                  {step.title}
                  <span className="sr-only">{complete ? ' (done)' : ''}</span>
                </p>
                {!complete && <p className="text-xs text-[var(--color-muted)]">{step.why}</p>}
              </div>
              {!complete && (
                <Link
                  href={step.href}
                  className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium"
                >
                  {step.action}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
