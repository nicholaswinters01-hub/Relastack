import { z } from 'zod';

/**
 * Fleet: the vehicles and equipment a business runs, what their meters say,
 * and the service they are due.
 *
 * A vehicle or trailer is also a place stock can sit, when the business uses
 * Inventory. Equipment (a sprayer, a fogger) carries no stock.
 */

export const fleetAssetKindSchema = z.enum(['VEHICLE', 'TRAILER', 'EQUIPMENT']);
export type FleetAssetKind = z.infer<typeof fleetAssetKindSchema>;

export const fleetAssetStatusSchema = z.enum(['ACTIVE', 'IN_SHOP', 'RETIRED']);
export type FleetAssetStatus = z.infer<typeof fleetAssetStatusSchema>;

/** What the asset's meter counts, if it has one. */
export const fleetMeterSchema = z.enum(['MILES', 'HOURS', 'NONE']);
export type FleetMeter = z.infer<typeof fleetMeterSchema>;

export const METER_UNIT: Record<FleetMeter, string> = { MILES: 'mi', HOURS: 'hrs', NONE: '' };

const MAX_READING = 99_999_999;

const reading = z
  .number({ invalid_type_error: 'Enter a number' })
  .finite()
  .min(0, 'A reading cannot be below zero')
  .max(MAX_READING, 'That reading is too large')
  .refine(
    (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-6,
    'Use at most one decimal place',
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

/** A calendar day, YYYY-MM-DD. Service is done on a day, not at an instant. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01');

// --- Assets ----------------------------------------------------------------

export const createAssetRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name, like "Van 3"').max(60),
  kind: fleetAssetKindSchema,
  locationId: z.string().uuid('Choose the branch it belongs to'),
  make: optionalText(60),
  model: optionalText(60),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  plate: optionalText(20),
  /** VIN for a vehicle, serial number for equipment. */
  identifier: optionalText(40),
  meter: fleetMeterSchema,
  assignedMembershipId: z.string().uuid().nullable().optional(),
  notes: optionalText(1000),
  /** The meter today, recorded as the first reading. */
  initialReading: reading.nullable().optional(),
});
export type CreateAssetRequest = z.infer<typeof createAssetRequestSchema>;

export const updateAssetRequestSchema = createAssetRequestSchema
  .omit({ initialReading: true })
  .partial()
  .extend({ status: fleetAssetStatusSchema.optional() });
export type UpdateAssetRequest = z.infer<typeof updateAssetRequestSchema>;

export const reminderStateSchema = z.enum(['OK', 'DUE_SOON', 'OVERDUE']);
export type ReminderState = z.infer<typeof reminderStateSchema>;

export const fleetReminderSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  intervalMonths: z.number().int().nullable(),
  intervalReading: z.number().nullable(),
  nextDueOn: z.string().nullable(),
  nextDueReading: z.number().nullable(),
  state: reminderStateSchema,
});
export type FleetReminder = z.infer<typeof fleetReminderSchema>;

export const fleetAssetSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: fleetAssetKindSchema,
  status: fleetAssetStatusSchema,
  locationId: z.string().uuid(),
  locationName: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  plate: z.string().nullable(),
  identifier: z.string().nullable(),
  meter: fleetMeterSchema,
  assignedMembershipId: z.string().uuid().nullable(),
  assignedName: z.string().nullable(),
  notes: z.string().nullable(),
  /** The latest reading, if any. */
  reading: z.number().nullable(),
  readingOn: z.string().nullable(),
  /** The worst state among its reminders, for a badge on the list. */
  serviceState: reminderStateSchema,
  reminders: z.array(fleetReminderSchema),
  /** Where this asset's stock is kept, when it carries stock at all. */
  stockPlaceId: z.string().uuid().nullable(),
  canManage: z.boolean(),
  /** Manage it, or it is assigned to the reader: they may log readings. */
  canLogReadings: z.boolean(),
});
export type FleetAsset = z.infer<typeof fleetAssetSchema>;

export const fleetResponseSchema = z.object({ assets: z.array(fleetAssetSchema) });
export type FleetResponse = z.infer<typeof fleetResponseSchema>;

export const fleetQuerySchema = z.object({
  includeRetired: z.enum(['true', 'false']).optional(),
});
export type FleetQuery = z.infer<typeof fleetQuerySchema>;

export const fleetReadingSchema = z.object({
  id: z.string().uuid(),
  value: z.number(),
  readOn: z.string(),
  recordedByName: z.string(),
});
export type FleetReading = z.infer<typeof fleetReadingSchema>;

export const fleetServiceRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  doneOn: z.string(),
  reading: z.number().nullable(),
  costCents: z.number().int().nullable(),
  note: z.string().nullable(),
  recordedByName: z.string(),
});
export type FleetServiceRecord = z.infer<typeof fleetServiceRecordSchema>;

export const assetDetailResponseSchema = z.object({
  asset: fleetAssetSchema,
  readings: z.array(fleetReadingSchema),
  services: z.array(fleetServiceRecordSchema),
});
export type AssetDetailResponse = z.infer<typeof assetDetailResponseSchema>;

// --- Readings, reminders and service ---------------------------------------

export const logReadingRequestSchema = z.object({
  value: reading,
  readOn: isoDateSchema.optional(),
  /** Resubmit with this set to record a reading below the last one. */
  acknowledgeLower: z.boolean().default(false),
});
export type LogReadingRequest = z.infer<typeof logReadingRequestSchema>;

export const createReminderRequestSchema = z
  .object({
    title: z.string().trim().min(1, 'Say what the service is').max(80),
    intervalMonths: z.number().int().min(1).max(120).nullable().optional(),
    intervalReading: reading
      .refine((v) => v > 0, 'Enter an interval above zero')
      .nullable()
      .optional(),
    /** When it is next due. Defaults to one interval from today. */
    nextDueOn: isoDateSchema.nullable().optional(),
    /** The meter reading it is next due at. Defaults to one interval from the latest. */
    nextDueReading: reading.nullable().optional(),
  })
  .refine(
    (value) =>
      value.intervalMonths != null ||
      value.intervalReading != null ||
      value.nextDueOn != null ||
      value.nextDueReading != null,
    'Give a repeat interval or a date it is due',
  );
export type CreateReminderRequest = z.infer<typeof createReminderRequestSchema>;

export const completeServiceRequestSchema = z.object({
  /** Leave out for service that was not on a reminder. */
  reminderId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(80).optional(),
  doneOn: isoDateSchema.optional(),
  reading: reading.nullable().optional(),
  costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  note: optionalText(500),
});
export type CompleteServiceRequest = z.infer<typeof completeServiceRequestSchema>;

// --- A vehicle on a job ----------------------------------------------------

export const setJobVehicleRequestSchema = z.object({
  vehicleId: z.string().uuid().nullable(),
  /** Resubmit with this set to book a vehicle already out on an overlapping job. */
  acknowledgeConflicts: z.boolean().default(false),
});
export type SetJobVehicleRequest = z.infer<typeof setJobVehicleRequestSchema>;
