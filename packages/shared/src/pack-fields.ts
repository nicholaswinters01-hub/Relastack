import { z } from 'zod';
import { MODULES } from './module';

/**
 * Fields a pack adds to core records.
 *
 * The connection point of the "packs plug into the core" design. A core
 * record carries a `pack_fields` JSONB column keyed by pack: { pest_control:
 * {...} }. The core never reads inside it. It asks this catalogue which
 * enabled packs add fields to that kind of record, and validates each pack's
 * part with that pack's schema. A key for a pack the business does not have
 * is refused, so nothing is stored that nobody will ever read.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31');
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

// --- Pest Control ----------------------------------------------------------

/** Suggestions only; any short phrase is accepted. */
export const PEST_TARGET_SUGGESTIONS = [
  'Ants',
  'Bed bugs',
  'Cockroaches',
  'Fleas',
  'Mosquitoes',
  'Rodents',
  'Spiders',
  'Termites',
  'Ticks',
  'Wasps and bees',
  'Silverfish',
  'Fire ants',
] as const;

export const PEST_AREA_SUGGESTIONS = [
  'Interior',
  'Exterior perimeter',
  'Kitchen',
  'Bathrooms',
  'Attic',
  'Crawlspace',
  'Garage',
  'Lawn',
  'Foundation',
  'Eaves',
] as const;

export const PEST_METHOD_SUGGESTIONS = [
  'Spray',
  'Bait',
  'Dust',
  'Granular',
  'Gel',
  'Fog',
  'Trap',
  'Injection',
] as const;

/** What a tech enters for one product applied on a visit. */
export const pestTreatmentFieldsSchema = z.object({
  targetPests: z.array(text(60).min(1)).min(1, 'Name at least one target pest').max(10),
  areas: z.array(text(60).min(1)).min(1, 'Say where it was applied').max(10),
  method: text(40).min(1, 'Say how it was applied'),
  /** The dilution, as written on the label: "0.8 fl oz per gallon". */
  mixRate: optionalText(60),
  windMph: z.number().min(0).max(150).nullable().optional(),
  temperatureF: z.number().min(-40).max(150).nullable().optional(),
  /** Who applied it, when not whoever is entering it. */
  applicatorMembershipId: z.string().uuid().nullable().optional(),
});
export type PestTreatmentFields = z.infer<typeof pestTreatmentFieldsSchema>;

/**
 * What is kept: the tech's entry plus what was true at the time. The product's
 * registration number and the applicator's license are copied in, so the
 * record stays right if the item or the license later changes.
 */
export const pestTreatmentRecordSchema = pestTreatmentFieldsSchema.extend({
  applicatorName: z.string(),
  applicatorLicense: z.string().nullable(),
  applicatorLicenseExpiresOn: z.string().nullable(),
  productName: z.string(),
  epaRegistrationNumber: z.string().nullable(),
  activeIngredient: z.string().nullable(),
});
export type PestTreatmentRecord = z.infer<typeof pestTreatmentRecordSchema>;

export const pestItemFieldsSchema = z.object({
  epaRegistrationNumber: optionalText(30),
  activeIngredient: optionalText(120),
});
export type PestItemFields = z.infer<typeof pestItemFieldsSchema>;

export const pestMemberFieldsSchema = z.object({
  licenseNumber: optionalText(40),
  licenseExpiresOn: isoDate.nullable().optional(),
});
export type PestMemberFields = z.infer<typeof pestMemberFieldsSchema>;

// --- The catalogue ---------------------------------------------------------

/** Kinds of core record a pack may add fields to. */
export type PackFieldTarget = 'item' | 'member' | 'jobUse';

export const PACK_FIELDS: Readonly<Record<string, Partial<Record<PackFieldTarget, z.ZodTypeAny>>>> =
  {
    [MODULES.PEST_CONTROL]: {
      item: pestItemFieldsSchema,
      member: pestMemberFieldsSchema,
      jobUse: pestTreatmentFieldsSchema,
    },
  };

/** Pack fields as sent and stored: keyed by pack. */
export const packFieldsSchema = z.record(z.string(), z.unknown());
export type PackFields = z.infer<typeof packFieldsSchema>;
