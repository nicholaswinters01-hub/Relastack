import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  occurrencesBetween,
  occursOn,
  wallTimeToInstant,
  type RecurrenceRule,
} from '@platform/shared';

/**
 * The recurrence maths.
 *
 * Tested harder than anything else in the codebase because it is pure, cheap
 * to exercise, and the failure mode is a crew at the wrong address at the
 * wrong hour with nobody finding out until a customer rings.
 */

const rule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: 'WEEKLY',
  interval: 1,
  byWeekday: [],
  // 2026-09-07 is a Monday.
  startsOn: '2026-09-07',
  until: null,
  ...overrides,
});

describe('weekly', () => {
  it('repeats on the starting weekday when none is named', () => {
    const weekly = rule();

    expect(occursOn(weekly, '2026-09-07')).toBe(true); // Monday
    expect(occursOn(weekly, '2026-09-14')).toBe(true);
    expect(occursOn(weekly, '2026-09-08')).toBe(false); // Tuesday
  });

  it('handles several days a week', () => {
    // Monday and Thursday.
    const weekly = rule({ byWeekday: [1, 4] });

    expect(occursOn(weekly, '2026-09-07')).toBe(true);
    expect(occursOn(weekly, '2026-09-10')).toBe(true);
    expect(occursOn(weekly, '2026-09-09')).toBe(false);
  });

  it('does fortnightly properly', () => {
    const fortnightly = rule({ interval: 2 });

    expect(occursOn(fortnightly, '2026-09-07')).toBe(true);
    expect(occursOn(fortnightly, '2026-09-14')).toBe(false);
    expect(occursOn(fortnightly, '2026-09-21')).toBe(true);
    expect(occursOn(fortnightly, '2026-09-28')).toBe(false);
  });

  it('keeps both days in the SAME week when fortnightly', () => {
    // The bug this guards: counting from each day independently puts Monday
    // and Thursday in alternating weeks, so a crew turns up weekly by
    // accident.
    const fortnightly = rule({ interval: 2, byWeekday: [1, 4] });

    expect(occursOn(fortnightly, '2026-09-07')).toBe(true); // Mon, week 0
    expect(occursOn(fortnightly, '2026-09-10')).toBe(true); // Thu, week 0
    expect(occursOn(fortnightly, '2026-09-14')).toBe(false); // Mon, week 1
    expect(occursOn(fortnightly, '2026-09-17')).toBe(false); // Thu, week 1
    expect(occursOn(fortnightly, '2026-09-21')).toBe(true); // Mon, week 2
  });

  it('produces nothing before the start', () => {
    expect(occursOn(rule(), '2026-08-31')).toBe(false);
  });

  it('stops at the end date, inclusive', () => {
    const bounded = rule({ until: '2026-09-21' });

    expect(occursOn(bounded, '2026-09-21')).toBe(true);
    expect(occursOn(bounded, '2026-09-28')).toBe(false);
  });
});

describe('daily', () => {
  it('repeats every day', () => {
    const daily = rule({ frequency: 'DAILY' });

    expect(occursOn(daily, '2026-09-08')).toBe(true);
    expect(occursOn(daily, '2026-09-09')).toBe(true);
  });

  it('honours an interval', () => {
    const everyThird = rule({ frequency: 'DAILY', interval: 3 });

    expect(occursOn(everyThird, '2026-09-07')).toBe(true);
    expect(occursOn(everyThird, '2026-09-08')).toBe(false);
    expect(occursOn(everyThird, '2026-09-10')).toBe(true);
  });
});

describe('monthly', () => {
  it('repeats on the same date', () => {
    const monthly = rule({ frequency: 'MONTHLY', startsOn: '2026-09-15' });

    expect(occursOn(monthly, '2026-10-15')).toBe(true);
    expect(occursOn(monthly, '2026-11-15')).toBe(true);
    expect(occursOn(monthly, '2026-10-14')).toBe(false);
  });

  it('skips a month that cannot hold the date', () => {
    const monthly = rule({ frequency: 'MONTHLY', startsOn: '2027-01-31' });

    expect(occursOn(monthly, '2027-01-31')).toBe(true);
    // February has no 31st. Clamping to the 28th would silently move the
    // visit three days earlier, which is worse than not producing one.
    expect(occursOn(monthly, '2027-02-28')).toBe(false);
    expect(occursOn(monthly, '2027-03-31')).toBe(true);
  });

  it('honours an interval across a year boundary', () => {
    const quarterly = rule({ frequency: 'MONTHLY', interval: 3, startsOn: '2026-11-05' });

    expect(occursOn(quarterly, '2027-02-05')).toBe(true);
    expect(occursOn(quarterly, '2026-12-05')).toBe(false);
  });
});

describe('listing a window', () => {
  it('returns the days in order', () => {
    const days = occurrencesBetween(rule({ interval: 2 }), '2026-09-01', '2026-10-05');

    expect(days).toEqual(['2026-09-07', '2026-09-21', '2026-10-05']);
  });

  it('never starts before the series does', () => {
    const days = occurrencesBetween(rule(), '2026-08-01', '2026-09-14');

    expect(days[0]).toBe('2026-09-07');
  });

  it('respects the limit rather than running away', () => {
    const days = occurrencesBetween(rule({ frequency: 'DAILY' }), '2026-09-07', '2036-09-07', 10);

    expect(days).toHaveLength(10);
  });
});

describe('wall-clock time in a zone', () => {
  const NY = 'America/New_York';

  it('turns 9am local into the right instant in summer', () => {
    // September: EDT, UTC-4. 9am local is 13:00Z.
    const instant = wallTimeToInstant('2026-09-07', 9 * 60, NY);

    expect(instant.toISOString()).toBe('2026-09-07T13:00:00.000Z');
  });

  it('and in winter, when the offset differs', () => {
    // January: EST, UTC-5. The same 9am is 14:00Z.
    const instant = wallTimeToInstant('2027-01-07', 9 * 60, NY);

    expect(instant.toISOString()).toBe('2027-01-07T14:00:00.000Z');
  });

  it('keeps 9am at 9am ACROSS the clocks changing', () => {
    // The whole reason the series stores minutes past midnight rather than an
    // offset. A stored offset would make half the year an hour wrong.
    const before = wallTimeToInstant('2027-03-13', 9 * 60, NY); // before DST
    const after = wallTimeToInstant('2027-03-15', 9 * 60, NY); // after DST

    const localHour = (instant: Date) =>
      Number(
        new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', hour12: false }).format(
          instant,
        ),
      );

    expect(localHour(before)).toBe(9);
    expect(localHour(after)).toBe(9);
    // And they are genuinely a different number of hours apart in UTC.
    expect(after.getTime() - before.getTime()).not.toBe(2 * 86_400_000);
  });

  it('works for a zone with no daylight saving at all', () => {
    const instant = wallTimeToInstant('2026-09-07', 9 * 60, 'America/Phoenix');

    expect(instant.toISOString()).toBe('2026-09-07T16:00:00.000Z');
  });

  it('handles midnight', () => {
    const instant = wallTimeToInstant('2026-09-07', 0, NY);

    expect(instant.toISOString()).toBe('2026-09-07T04:00:00.000Z');
  });
});

describe('describing a rule to a person', () => {
  it('reads naturally', () => {
    expect(describeRecurrence(rule())).toBe('Every week on Monday');
    expect(describeRecurrence(rule({ interval: 2 }))).toBe('Every other week on Monday');
    expect(describeRecurrence(rule({ byWeekday: [1, 4] }))).toBe(
      'Every week on Monday and Thursday',
    );
    expect(describeRecurrence(rule({ frequency: 'DAILY' }))).toBe('Every day');
  });

  it('gets the ordinal right', () => {
    expect(describeRecurrence(rule({ frequency: 'MONTHLY', startsOn: '2026-09-01' }))).toContain(
      '1st',
    );
    expect(describeRecurrence(rule({ frequency: 'MONTHLY', startsOn: '2026-09-02' }))).toContain(
      '2nd',
    );
    expect(describeRecurrence(rule({ frequency: 'MONTHLY', startsOn: '2026-09-03' }))).toContain(
      '3rd',
    );
    expect(describeRecurrence(rule({ frequency: 'MONTHLY', startsOn: '2026-09-11' }))).toContain(
      '11th',
    );
    expect(describeRecurrence(rule({ frequency: 'MONTHLY', startsOn: '2026-09-21' }))).toContain(
      '21st',
    );
  });
});
