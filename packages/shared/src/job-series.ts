import { z } from 'zod';
import { recurrenceFrequencySchema } from './recurrence';

/**
 * Repeating work.
 *
 * A series is a template plus a rule. Its occurrences are ordinary job rows,
 * generated over a rolling horizon — so a crew, a completion or a moved visit
 * are all just edits to a job, and none of it needs a parallel exception
 * table with its own permissions to get wrong.
 */

/** How far ahead visits are booked. Roughly a quarter. */
export const MATERIALISE_DAYS = 90;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const jobSeriesSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),

  frequency: recurrenceFrequencySchema,
  interval: z.number().int().positive(),
  byWeekday: z.array(z.number().int().min(0).max(6)),
  startsOn: z.string(),
  until: z.string().nullable(),
  /** Plain-English version of the rule, built once on the server. */
  summary: z.string(),

  startMinutes: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().positive(),

  active: z.boolean(),

  locationId: z.string().uuid().nullable(),
  locationName: z.string().nullable(),
  locationTimezone: z.string().nullable(),

  customerId: z.string().uuid().nullable(),
  /** Null when the reader may not see that customer — same rule as jobs. */
  customerName: z.string().nullable(),

  addressLine1: z.string().nullable(),
  city: z.string().nullable(),

  assignees: z.array(z.object({ membershipId: z.string().uuid(), name: z.string() })),

  /** How many visits are currently booked from it. */
  bookedCount: z.number().int().nonnegative(),

  createdAt: z.string().datetime(),
});

export type JobSeries = z.infer<typeof jobSeriesSchema>;

const seriesFields = {
  title: z.string().trim().min(1, 'A series needs a title').max(200),
  description: z
    .string()
    .trim()
    .max(5000)
    .transform((value) => (value === '' ? undefined : value))
    .optional(),

  frequency: recurrenceFrequencySchema,
  interval: z.coerce.number().int().min(1).max(52).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).default([]),

  startsOn: z.string().regex(DAY, 'Use a date like 2026-09-07'),
  until: z.string().regex(DAY, 'Use a date like 2026-09-07').nullable().optional(),

  /** Minutes past local midnight — wall-clock, so it survives a clock change. */
  startMinutes: z.coerce.number().int().min(0).max(1439),
  durationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60),

  locationId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
  assigneeMembershipIds: z.array(z.string().uuid()).max(50).default([]),
};

export const createJobSeriesRequestSchema = z
  .object(seriesFields)
  .refine(
    (value) => value.until === null || value.until === undefined || value.until >= value.startsOn,
    {
      message: 'The series cannot end before it starts',
      path: ['until'],
    },
  );

export type CreateJobSeriesRequest = z.infer<typeof createJobSeriesRequestSchema>;

export const updateJobSeriesRequestSchema = z.object({
  ...seriesFields,
  title: seriesFields.title.optional(),
  frequency: recurrenceFrequencySchema.optional(),
  interval: z.coerce.number().int().min(1).max(52).optional(),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startsOn: z.string().regex(DAY).optional(),
  startMinutes: z.coerce.number().int().min(0).max(1439).optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  assigneeMembershipIds: z.array(z.string().uuid()).max(50).optional(),
  /** Stop producing new visits. Everything already booked stays. */
  active: z.boolean().optional(),
});

export type UpdateJobSeriesRequest = z.infer<typeof updateJobSeriesRequestSchema>;

export const jobSeriesListResponseSchema = z.object({ series: z.array(jobSeriesSchema) });
export type JobSeriesListResponse = z.infer<typeof jobSeriesListResponseSchema>;

export const jobSeriesResponseSchema = z.object({
  series: jobSeriesSchema,
  /**
   * How many visits the change created or removed.
   *
   * Reported so the interface can say "12 visits booked" rather than leaving
   * someone to wonder whether anything happened.
   */
  booked: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
});

export type JobSeriesResponse = z.infer<typeof jobSeriesResponseSchema>;
