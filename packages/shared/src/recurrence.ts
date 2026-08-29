import { z } from 'zod';

/**
 * Turning a repeat rule into actual dates and times.
 *
 * Kept pure and free of any database so it can be tested exhaustively, which
 * matters more here than anywhere else in the codebase: an off-by-one in a
 * weekday, or an hour lost to daylight saving, sends a crew to the wrong place
 * at the wrong time and nobody finds out until a customer rings.
 */

export const recurrenceFrequencySchema = z.enum(['DAILY', 'WEEKLY', 'MONTHLY']);
export type RecurrenceFrequency = z.infer<typeof recurrenceFrequencySchema>;

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Every N periods. 2 with WEEKLY is fortnightly. */
  interval: number;
  /** Days of the week for WEEKLY, 0 = Sunday. Ignored otherwise. */
  byWeekday: number[];
  /** First eligible day, as YYYY-MM-DD in the branch's own timezone. */
  startsOn: string;
  /** Last eligible day, inclusive. Null runs indefinitely. */
  until: string | null;
}

/** A calendar day, as the branch would write it. */
const toParts = (day: string): { year: number; month: number; date: number } => {
  const [year, month, date] = day.split('-').map(Number);

  return { year: year!, month: month!, date: date! };
};

const toDay = (year: number, month: number, date: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

/**
 * Calendar arithmetic done in UTC deliberately.
 *
 * These are *dates*, not instants — "the 7th of September" is the same day
 * whatever zone you are in. Using UTC here keeps the arithmetic free of
 * daylight saving entirely; the zone is applied later, once, when the day and
 * a wall-clock time become a real instant.
 */
const asUtc = (day: string): Date => {
  const { year, month, date } = toParts(day);

  return new Date(Date.UTC(year, month - 1, date));
};

const fromUtc = (value: Date): string =>
  toDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());

/** Whole days between two calendar days. */
const daysBetween = (from: string, to: string): number =>
  Math.round((asUtc(to).getTime() - asUtc(from).getTime()) / 86_400_000);

/**
 * Does the rule produce a visit on this day?
 *
 * WEEKLY counts whole weeks from the week the series starts, so "every second
 * Tuesday" stays on the same fortnightly rhythm even when the series begins
 * mid-week.
 */
export function occursOn(rule: RecurrenceRule, day: string): boolean {
  if (day < rule.startsOn) return false;
  if (rule.until !== null && day > rule.until) return false;

  const elapsed = daysBetween(rule.startsOn, day);

  switch (rule.frequency) {
    case 'DAILY':
      return elapsed % rule.interval === 0;

    case 'WEEKLY': {
      const weekday = asUtc(day).getUTCDay();

      // An empty byWeekday means "the same weekday the series started on",
      // which is what someone means by "every week" without saying more.
      const days = rule.byWeekday.length > 0 ? rule.byWeekday : [asUtc(rule.startsOn).getUTCDay()];

      if (!days.includes(weekday)) return false;

      // Count from the START of the series' week, so a Monday-and-Thursday
      // fortnightly series keeps both days in the same weeks rather than
      // alternating between them.
      const startOfFirstWeek = daysBetween(rule.startsOn, day) + asUtc(rule.startsOn).getUTCDay();
      const weeksElapsed = Math.floor(startOfFirstWeek / 7);

      return weeksElapsed % rule.interval === 0;
    }

    case 'MONTHLY': {
      const start = toParts(rule.startsOn);
      const here = toParts(day);

      const monthsElapsed = (here.year - start.year) * 12 + (here.month - start.month);
      if (monthsElapsed % rule.interval !== 0) return false;

      // A series starting on the 31st has no March occurrence in a 30-day
      // month. Clamping to the last day instead would silently move the visit,
      // so a month that cannot hold the date simply produces nothing.
      return here.date === start.date;
    }
  }
}

/** Every day the rule produces within a window, inclusive of both ends. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: string,
  to: string,
  /** Safety valve. A daily series over a decade is not a useful materialisation. */
  limit = 500,
): string[] {
  const days: string[] = [];
  const cursor = asUtc(from > rule.startsOn ? from : rule.startsOn);
  const end = asUtc(to);

  while (cursor.getTime() <= end.getTime() && days.length < limit) {
    const day = fromUtc(cursor);

    if (occursOn(rule, day)) days.push(day);

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

/**
 * What UTC offset does a zone have at a given instant?
 *
 * Derived by formatting the instant in that zone and reading the wall-clock
 * back, which is the only way to do this without shipping a timezone database.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );

  // Hour 24 appears at midnight in some locales; normalise it to 0.
  const hour = Number(parts.hour) % 24;

  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );

  return (wallAsUtc - instant.getTime()) / 60_000;
}

/**
 * A calendar day plus a wall-clock time, in a zone, as a real instant.
 *
 * This is why the series stores minutes-past-midnight rather than an offset:
 * "9am every Tuesday" must stay 9am when the clocks change, and a stored
 * offset would silently become 8am or 10am for half the year.
 *
 * Two passes. The first guess assumes the zone's offset is whatever it is at
 * the naive instant; if the guess lands on the other side of a daylight-saving
 * boundary the offset differs there, so it is corrected once. That converges
 * for every real zone.
 */
export function wallTimeToInstant(day: string, minutes: number, timeZone: string): Date {
  const { year, month, date } = toParts(day);
  const naive = Date.UTC(year, month - 1, date, 0, minutes);

  const firstPass = new Date(naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000);
  const offset = offsetMinutesAt(firstPass, timeZone);

  return new Date(naive - offset * 60_000);
}

/** Human summary of a rule, for a list that has no room for the detail. */
export function describeRecurrence(rule: RecurrenceRule): string {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const every = rule.interval === 1 ? '' : `${rule.interval} `;

  switch (rule.frequency) {
    case 'DAILY':
      return rule.interval === 1 ? 'Every day' : `Every ${every}days`;

    case 'WEEKLY': {
      const days =
        rule.byWeekday.length > 0
          ? rule.byWeekday
              .slice()
              .sort((a, b) => a - b)
              .map((day) => WEEKDAYS[day])
              .join(' and ')
          : WEEKDAYS[asUtc(rule.startsOn).getUTCDay()];

      return rule.interval === 2 ? `Every other week on ${days}` : `Every ${every}week on ${days}`;
    }

    case 'MONTHLY': {
      const { date } = toParts(rule.startsOn);
      const ordinal =
        date % 10 === 1 && date !== 11
          ? 'st'
          : date % 10 === 2 && date !== 12
            ? 'nd'
            : date % 10 === 3 && date !== 13
              ? 'rd'
              : 'th';

      return `Every ${every}month on the ${date}${ordinal}`;
    }
  }
}
