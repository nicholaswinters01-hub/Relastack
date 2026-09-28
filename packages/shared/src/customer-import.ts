import { z } from 'zod';

/**
 * Importing customers from a spreadsheet.
 *
 * The file is read in the browser and never stored: what reaches the server
 * is rows of text, one object per line, already matched to our fields. The
 * server checks every row with the same rules as adding a customer by hand,
 * and says what is wrong with each before anything is saved.
 */

/** Per file. Keeps a request well under the size limit; bigger lists can be split. */
export const IMPORT_MAX_ROWS = 1000;

/** The fields a column can be matched to, besides the business's own custom fields. */
export const IMPORT_FIELDS = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'companyName', label: 'Company name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'addressLine1', label: 'Address' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'State / region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  { key: 'source', label: 'Source' },
  { key: 'accountNumber', label: 'Account number' },
  { key: 'note', label: 'Note' },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];

const cell = z.string().max(5000).optional();

export const importRowSchema = z.object({
  firstName: cell,
  lastName: cell,
  companyName: cell,
  email: cell,
  phone: cell,
  addressLine1: cell,
  addressLine2: cell,
  city: cell,
  region: cell,
  postalCode: cell,
  country: cell,
  source: cell,
  accountNumber: cell,
  note: cell,
  /** Keyed by custom field key. Text as it appeared in the file. */
  customFields: z.record(z.string(), z.string().max(2000)).optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const customerImportRequestSchema = z.object({
  locationId: z.string().uuid().nullable(),
  stage: z.enum(['ACTIVE', 'LEAD']),
  rows: z
    .array(importRowSchema)
    .min(1, 'The file has no rows')
    .max(IMPORT_MAX_ROWS, `Up to ${IMPORT_MAX_ROWS} customers per file; split bigger lists`),
});
export type CustomerImportRequest = z.infer<typeof customerImportRequestSchema>;

export const importRowResultSchema = z.object({
  /** Zero-based position in the request's rows. */
  index: z.number().int().nonnegative(),
  status: z.enum(['ready', 'duplicate', 'invalid']),
  errors: z.array(z.string()),
  /** For a duplicate: the customer it matched, or the earlier row in the same file. */
  duplicateOf: z
    .object({
      customerId: z.string().uuid().nullable(),
      displayName: z.string(),
      accountNumber: z.number().int().nullable(),
      row: z.number().int().nullable(),
    })
    .nullable(),
});
export type ImportRowResult = z.infer<typeof importRowResultSchema>;

export const customerImportPreviewSchema = z.object({
  rows: z.array(importRowResultSchema),
  counts: z.object({
    ready: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
});
export type CustomerImportPreview = z.infer<typeof customerImportPreviewSchema>;

export const customerImportResultSchema = z.object({
  created: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  skippedInvalid: z.number().int().nonnegative(),
  /** Every imported customer carries it, so a bad import is easy to find and archive. */
  tag: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
});
export type CustomerImportResult = z.infer<typeof customerImportResultSchema>;
