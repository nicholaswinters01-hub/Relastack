import { z } from 'zod';

/**
 * Scheduling.
 *
 * A job is work booked into a slot: a customer, a place, a window of time, and
 * a crew. The crew is what makes this structurally different from a task —
 * tasks have one assignee, jobs routinely have three.
 *
 * Times cross the wire as instants. They are rendered in the branch's timezone,
 * which is why Location has carried one since Phase 3.
 */

export const jobStatusSchema = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Statuses where the visit is still expected to happen. */
export const LIVE_JOB_STATUSES: JobStatus[] = ['SCHEDULED', 'IN_PROGRESS'];

/**
 * Statuses that no longer occupy the slot.
 *
 * NO_SHOW counts as closed but is deliberately not CANCELLED: one is a
 * customer who called ahead, the other is a crew that drove there for nothing,
 * and only one of those should make a business think about deposits.
 */
export const CLOSED_JOB_STATUSES: JobStatus[] = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

/**
 * Do two windows overlap?
 *
 * Half-open on purpose: a job ending at 2pm does not clash with one starting at
 * 2pm. Treating touching windows as a conflict would warn on every
 * back-to-back booking, which is the normal way a day is filled, and a warning
 * that fires constantly is one nobody reads.
 */
export function windowsOverlap(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean {
  return (
    new Date(a.startsAt).getTime() < new Date(b.endsAt).getTime() &&
    new Date(a.endsAt).getTime() > new Date(b.startsAt).getTime()
  );
}

export const jobAssigneeSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string(),
});

export type JobAssignee = z.infer<typeof jobAssigneeSchema>;

export const jobSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: jobStatusSchema,

  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),

  locationId: z.string().uuid().nullable(),
  locationName: z.string().nullable(),
  /** The branch's zone, so the browser can render the time as the crew reads it. */
  locationTimezone: z.string().nullable(),

  customerId: z.string().uuid().nullable(),
  /**
   * Null when the job is internal — but ALSO null when the reader may not see
   * that customer. Same rule as tasks: being on a job says nothing about being
   * allowed to know whose job it is.
   */
  customerName: z.string().nullable(),
  /** Hidden exactly when the name is. */
  customerAccountNumber: z.number().int().nullable(),

  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),

  assignees: z.array(jobAssigneeSchema),
  /** The vehicle the crew takes, when the business uses Fleet. */
  vehicleId: z.string().uuid().nullable(),
  vehicleName: z.string().nullable(),
  createdByName: z.string().nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Job = z.infer<typeof jobSchema>;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

const jobFields = {
  title: z.string().trim().min(1, 'A job needs a title').max(200),
  description: optionalText(5000, 'Description'),
  locationId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  addressLine1: optionalText(200, 'Address'),
  addressLine2: optionalText(200, 'Address'),
  city: optionalText(100, 'City'),
  region: optionalText(100, 'Region'),
  postalCode: optionalText(20, 'Postal code'),
  country: optionalText(100, 'Country'),
  assigneeMembershipIds: z.array(z.string().uuid()).max(50).optional(),
  /**
   * Book despite a clash.
   *
   * Conflicts warn rather than block: real businesses overlap on purpose, and
   * software that refuses gets worked around by putting the job in the wrong
   * slot — which is worse than the overlap it prevented. The first attempt
   * returns the clash, and the caller resubmits with this set.
   */
  acknowledgeConflicts: z.boolean().default(false),
};

export const createJobRequestSchema = z
  .object({
    ...jobFields,
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    status: jobStatusSchema.default('SCHEDULED'),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: 'The job has to end after it starts',
    path: ['endsAt'],
  });

export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const updateJobRequestSchema = z
  .object({
    ...jobFields,
    title: jobFields.title.optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    status: jobStatusSchema.optional(),
  })
  .refine(
    (value) =>
      value.startsAt === undefined ||
      value.endsAt === undefined ||
      new Date(value.endsAt) > new Date(value.startsAt),
    { message: 'The job has to end after it starts', path: ['endsAt'] },
  );

export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;

/** One person, already booked, in a window that overlaps the requested one. */
export const jobConflictSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string(),
  jobId: z.string().uuid(),
  jobTitle: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export type JobConflict = z.infer<typeof jobConflictSchema>;

/**
 * Returned with 409 when a booking would double-book somebody.
 *
 * A refusal the caller can act on rather than a dead end: it names who, when,
 * and on what, so the interface can offer "book anyway" or "pick another time"
 * instead of a shrug.
 */
export const jobConflictResponseSchema = z.object({
  statusCode: z.literal(409),
  code: z.literal('SCHEDULE_CONFLICT'),
  message: z.string(),
  conflicts: z.array(jobConflictSchema),
});

export type JobConflictResponse = z.infer<typeof jobConflictResponseSchema>;

export const jobQuerySchema = z.object({
  /** Inclusive lower bound on the job's start. */
  from: z.string().datetime({ offset: true }).optional(),
  /** Exclusive upper bound. Together these are the calendar window. */
  to: z.string().datetime({ offset: true }).optional(),
  status: jobStatusSchema.optional(),
  liveOnly: z.coerce.boolean().default(false),
  customerId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  assigneeMembershipId: z.string().uuid().optional(),
  /** Shorthand for "on my schedule", so the client need not know its own id. */
  mine: z.coerce.boolean().default(false),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().uuid().optional(),
});

export type JobQuery = z.infer<typeof jobQuerySchema>;

export const jobsResponseSchema = z.object({
  jobs: z.array(jobSchema),
  nextCursor: z.string().uuid().nullable(),
});

export type JobsResponse = z.infer<typeof jobsResponseSchema>;

export const jobResponseSchema = z.object({ job: jobSchema });
export type JobResponse = z.infer<typeof jobResponseSchema>;

// --- Customer sign-off -------------------------------------------------------

/** A signature drawn on the tech's phone, as a PNG data URL. */
export const SIGNATURE_MAX_LENGTH = 200_000;

export const jobSignoffSchema = z.object({
  id: z.string().uuid(),
  signerName: z.string(),
  image: z.string(),
  signedAt: z.string().datetime(),
  recordedByName: z.string(),
});
export type JobSignoff = z.infer<typeof jobSignoffSchema>;

export const jobSignoffResponseSchema = z.object({ signoff: jobSignoffSchema.nullable() });
export type JobSignoffResponse = z.infer<typeof jobSignoffResponseSchema>;

export const createSignoffRequestSchema = z.object({
  signerName: z.string().trim().min(1, 'Who is signing?').max(120),
  image: z
    .string()
    .startsWith('data:image/png;base64,', 'The signature must be a PNG image')
    .max(SIGNATURE_MAX_LENGTH, 'That signature is too large'),
});
export type CreateSignoffRequest = z.infer<typeof createSignoffRequestSchema>;
