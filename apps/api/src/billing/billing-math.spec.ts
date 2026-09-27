import {
  addBillingInterval,
  creditBalance,
  daysUntil,
  nextCoverageStart,
  paidThroughOf,
  unusedValue,
} from '@platform/shared';
import { describe, expect, it } from 'vitest';

/**
 * The arithmetic of billing by hand.
 *
 * Pure functions from @platform/shared, tested here because this is where the
 * API's unit tests run. Every figure staff quote to a customer comes from these.
 */

const DAY = 24 * 60 * 60 * 1000;
const utc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('addBillingInterval', () => {
  it('moves a month by the calendar, not by 30 days', () => {
    expect(addBillingInterval(utc('2026-03-15'), 'MONTHLY')).toEqual(utc('2026-04-15'));
    expect(addBillingInterval(utc('2026-12-15'), 'MONTHLY')).toEqual(utc('2027-01-15'));
  });

  it('ends a month paid on the 31st on the last day of a shorter month, not in the next', () => {
    expect(addBillingInterval(utc('2027-01-31'), 'MONTHLY')).toEqual(utc('2027-02-28'));
    expect(addBillingInterval(utc('2028-01-31'), 'MONTHLY')).toEqual(utc('2028-02-29'));
  });

  it('moves a year to the same day, or the 28th from a leap day', () => {
    expect(addBillingInterval(utc('2026-09-27'), 'ANNUAL')).toEqual(utc('2027-09-27'));
    expect(addBillingInterval(utc('2028-02-29'), 'ANNUAL')).toEqual(utc('2029-02-28'));
  });

  it('keeps the time of day', () => {
    const from = new Date('2026-09-27T17:45:12.345Z');
    expect(addBillingInterval(from, 'MONTHLY').toISOString()).toBe('2026-10-27T17:45:12.345Z');
  });
});

describe('nextCoverageStart', () => {
  const now = utc('2026-09-27').getTime();

  it('lets a business paying during its trial keep the trial days', () => {
    const trialEndsAt = utc('2026-10-05');

    expect(
      nextCoverageStart({ effectiveStatus: 'TRIALING', trialEndsAt, paidThrough: null }, now),
    ).toEqual(trialEndsAt);
  });

  it('continues a paying business from where its paid time ends', () => {
    const paidThrough = utc('2026-10-10');

    expect(
      nextCoverageStart({ effectiveStatus: 'ACTIVE', trialEndsAt: null, paidThrough }, now),
    ).toEqual(paidThrough);
  });

  it('continues from the old end during the grace period, so grace is not given twice', () => {
    const paidThrough = utc('2026-09-20');

    expect(
      nextCoverageStart({ effectiveStatus: 'PAST_DUE', trialEndsAt: null, paidThrough }, now),
    ).toEqual(paidThrough);
  });

  it('starts now for a read-only business, which should not pay for the time it was locked', () => {
    expect(
      nextCoverageStart(
        { effectiveStatus: 'SUSPENDED', trialEndsAt: null, paidThrough: utc('2026-06-01') },
        now,
      ),
    ).toEqual(new Date(now));
  });

  it('starts now for a trial that has already run out', () => {
    expect(
      nextCoverageStart(
        { effectiveStatus: 'SUSPENDED', trialEndsAt: utc('2026-09-01'), paidThrough: null },
        now,
      ),
    ).toEqual(new Date(now));
  });
});

describe('unusedValue', () => {
  const from = utc('2026-01-01');
  const until = utc('2027-01-01');
  const year = until.getTime() - from.getTime();

  it('prorates an annual payment by time', () => {
    const halfway = from.getTime() + year / 2;

    expect(
      unusedValue(
        [{ amountCents: 120_000, creditAppliedCents: 0, coversFrom: from, coversUntil: until }],
        halfway,
      ),
    ).toEqual({ unusedCents: 60_000, paidCents: 120_000 });
  });

  it('counts credit spent on a period as paid for it', () => {
    const halfway = from.getTime() + year / 2;

    expect(
      unusedValue(
        [
          {
            amountCents: 100_000,
            creditAppliedCents: 20_000,
            coversFrom: from,
            coversUntil: until,
          },
        ],
        halfway,
      ).unusedCents,
    ).toBe(60_000);
  });

  it('treats a period not yet started as wholly unused', () => {
    expect(
      unusedValue(
        [{ amountCents: 2_900, creditAppliedCents: 0, coversFrom: from, coversUntil: until }],
        from.getTime() - DAY,
      ).unusedCents,
    ).toBe(2_900);
  });

  it('leaves out a period that is over', () => {
    expect(
      unusedValue(
        [{ amountCents: 2_900, creditAppliedCents: 0, coversFrom: from, coversUntil: until }],
        until.getTime(),
      ),
    ).toEqual({ unusedCents: 0, paidCents: 0 });
  });

  it('adds up a current period and a renewal paid in advance', () => {
    const renewalUntil = utc('2028-01-01');
    const halfway = from.getTime() + year / 2;

    expect(
      unusedValue(
        [
          { amountCents: 120_000, creditAppliedCents: 0, coversFrom: from, coversUntil: until },
          {
            amountCents: 120_000,
            creditAppliedCents: 0,
            coversFrom: until,
            coversUntil: renewalUntil,
          },
        ],
        halfway,
      ),
    ).toEqual({ unusedCents: 180_000, paidCents: 240_000 });
  });
});

describe('small helpers', () => {
  it('sums a credit ledger, spending included', () => {
    expect(
      creditBalance([{ amountCents: 5_000 }, { amountCents: -2_000 }, { amountCents: 500 }]),
    ).toBe(3_500);
    expect(creditBalance([])).toBe(0);
  });

  it('rounds days left up, and never below zero', () => {
    const now = utc('2026-09-27').getTime();

    expect(daysUntil(new Date(now + 1.5 * DAY), now)).toBe(2);
    expect(daysUntil(new Date(now - DAY), now)).toBe(0);
  });

  it('finds the latest paid-through date, or none', () => {
    expect(paidThroughOf([])).toBeNull();
    expect(
      paidThroughOf([{ coversUntil: utc('2026-10-01') }, { coversUntil: utc('2027-10-01') }]),
    ).toEqual(utc('2027-10-01'));
  });
});
