import { z } from 'zod';
import { jobStatusSchema } from './job';

/**
 * The manager's board: a branch's day at a glance, and calls for a manager
 * from the field.
 *
 * Where someone is comes from the job they marked "On site", never from their
 * phone's location. The crew already sets it, and nobody is tracked.
 */

// --- "Need a manager" --------------------------------------------------------

export const helpRequestStatusSchema = z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
export type HelpRequestStatus = z.infer<typeof helpRequestStatusSchema>;

export const helpRequestSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  jobTitle: z.string(),
  locationName: z.string().nullable(),
  status: helpRequestStatusSchema,
  note: z.string().nullable(),
  requestedByName: z.string(),
  createdAt: z.string().datetime(),
  acknowledgedByName: z.string().nullable(),
  acknowledgedAt: z.string().datetime().nullable(),
  resolvedByName: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  /** May acknowledge and resolve it: a manager of its branch. */
  canManage: z.boolean(),
});
export type HelpRequest = z.infer<typeof helpRequestSchema>;

export const createHelpRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type CreateHelpRequest = z.infer<typeof createHelpRequestSchema>;

export const jobHelpResponseSchema = z.object({
  /** The call still open on this job, else the latest one. */
  request: helpRequestSchema.nullable(),
  /** On the crew, so may call for a manager. */
  canRequest: z.boolean(),
});
export type JobHelpResponse = z.infer<typeof jobHelpResponseSchema>;

// --- The board -----------------------------------------------------------------

export const boardJobSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: jobStatusSchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  /** Hidden, as everywhere, when the reader may not see the customer. */
  customerName: z.string().nullable(),
  locationName: z.string().nullable(),
  vehicleName: z.string().nullable(),
  crew: z.array(z.string()),
  /** Not started though its start has passed, or on site past its end. */
  late: z.boolean(),
});
export type BoardJob = z.infer<typeof boardJobSchema>;

export const boardPersonStateSchema = z.enum(['ON_SITE', 'BETWEEN_JOBS', 'DONE', 'NOTHING_BOOKED']);
export type BoardPersonState = z.infer<typeof boardPersonStateSchema>;

export const boardPersonSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string(),
  state: boardPersonStateSchema,
  current: boardJobSchema.nullable(),
  next: boardJobSchema.nullable(),
  jobCount: z.number().int(),
  doneCount: z.number().int(),
});
export type BoardPerson = z.infer<typeof boardPersonSchema>;

export const boardResponseSchema = z.object({
  day: z.string(),
  /** Branches the reader runs; the board shows one of them, or all. */
  locations: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  locationId: z.string().uuid().nullable(),
  people: z.array(boardPersonSchema),
  unassigned: z.array(boardJobSchema),
  late: z.array(boardJobSchema),
  help: z.array(helpRequestSchema),
  counts: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    inProgress: z.number().int(),
    remaining: z.number().int(),
  }),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

export const boardQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;
