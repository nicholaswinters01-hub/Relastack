import { z } from 'zod';
import { pestTreatmentRecordSchema } from './pack-fields';

/**
 * Pest application records: every product applied on every visit, with the
 * job it was applied on. For a customer's history, a printout, or an export
 * for an inspection.
 */

export const pestRecordSchema = z.object({
  movementId: z.string().uuid(),
  jobId: z.string().uuid(),
  jobTitle: z.string(),
  appliedAt: z.string().datetime(),
  /** Hidden, like on the job itself, when the reader may not see the customer. */
  customerId: z.string().uuid().nullable(),
  customerName: z.string().nullable(),
  address: z.string().nullable(),
  locationName: z.string().nullable(),
  /** The branch's time zone, so a record reads in the branch's own day. */
  timezone: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
  placeName: z.string(),
  treatment: pestTreatmentRecordSchema,
  voided: z.boolean(),
});
export type PestRecord = z.infer<typeof pestRecordSchema>;

export const pestRecordsResponseSchema = z.object({ records: z.array(pestRecordSchema) });
export type PestRecordsResponse = z.infer<typeof pestRecordsResponseSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01');

export const pestRecordsQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
  customerId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
});
export type PestRecordsQuery = z.infer<typeof pestRecordsQuerySchema>;
