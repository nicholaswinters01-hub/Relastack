import { z } from 'zod';

/**
 * Reporting.
 *
 * Every number here is computed through the SAME visibility filter the
 * underlying list endpoints use. That is the whole risk of the phase: an
 * aggregate is still a disclosure. "You have 40 customers" told to a branch
 * employee who can see four of them leaks the size of the book, and a count
 * filtered by a tag or a date can be narrowed until it identifies one person.
 */

export const reportRangeSchema = z.object({
  /** Inclusive start of the window, as a calendar day. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Inclusive end. Defaults to a trailing 30 days ending today. */
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type ReportRange = z.infer<typeof reportRangeSchema>;

/** One bar in a small chart: a day and how many things happened on it. */
export const dailyCountSchema = z.object({
  day: z.string(),
  count: z.number().int().nonnegative(),
});

export type DailyCount = z.infer<typeof dailyCountSchema>;

export const dashboardSchema = z.object({
  /** The window these numbers cover, echoed back so the page can say so. */
  from: z.string(),
  to: z.string(),

  customers: z.object({
    /** Everything the reader may see, whatever its stage. */
    total: z.number().int().nonnegative(),
    leads: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    /** Became a customer inside the window. */
    convertedInRange: z.number().int().nonnegative(),
    addedInRange: z.number().int().nonnegative(),
  }),

  tasks: z.object({
    open: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    /** Assigned to whoever is asking. The number they actually act on. */
    mine: z.number().int().nonnegative(),
    completedInRange: z.number().int().nonnegative(),
  }),

  jobs: z.object({
    scheduledAhead: z.number().int().nonnegative(),
    completedInRange: z.number().int().nonnegative(),
    cancelledInRange: z.number().int().nonnegative(),
    noShowInRange: z.number().int().nonnegative(),
    /**
     * No-shows as a percentage of visits that were meant to happen.
     *
     * Null rather than zero when nothing was scheduled — a rate over no
     * visits is not 0%, it is unanswerable, and showing 0% would read as
     * "perfect" rather than "no data".
     */
    noShowRate: z.number().nullable(),
    /** Jobs finished per day in the window, for a small chart. */
    completedByDay: z.array(dailyCountSchema),
  }),

  /**
   * Whether these numbers cover the whole company or only some branches.
   *
   * Sent so the page can say "your locations" rather than implying a
   * company-wide total that a scoped reader is not seeing.
   */
  scope: z.object({
    organizationWide: z.boolean(),
    locationCount: z.number().int().nonnegative(),
  }),
});

export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardResponseSchema = z.object({ dashboard: dashboardSchema });
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
