import { z } from 'zod';

/**
 * Customers, contacts, notes, tags and custom fields.
 *
 * The first business data the platform holds. Everything here is tenant-owned
 * and protected by row-level security; these contracts describe the shape that
 * crosses the wire, never the authorization.
 */

/**
 * Where a customer sits in their lifecycle.
 *
 * One record moves through these rather than a Lead graduating into a
 * Customer. Converting is a status change, so every note, contact and tag
 * written while they were a lead survives it.
 */
export const customerStageSchema = z.enum(['LEAD', 'ACTIVE', 'INACTIVE', 'ARCHIVED']);
export type CustomerStage = z.infer<typeof customerStageSchema>;

export const customerTypeSchema = z.enum(['PERSON', 'COMPANY']);
export type CustomerType = z.infer<typeof customerTypeSchema>;

/** Stages a customer can be moved to by hand. ARCHIVED has its own endpoint. */
export const ASSIGNABLE_STAGES: CustomerStage[] = ['LEAD', 'ACTIVE', 'INACTIVE'];

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

const optionalEmail = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine(
    (value) => value === undefined || z.string().email().safeParse(value).success,
    'Enter a valid email address',
  );

/*
 * For editing: an emptied box means "remove this", which only null can say.
 * The create versions above turn it into "not given", which on an edit would
 * silently keep the old value while reporting success.
 */
const clearableText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const clearableEmail = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()
  .refine(
    (value) => value == null || z.string().email().safeParse(value).success,
    'Enter a valid email address',
  );

export const CUSTOMER_NAME_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export const customFieldTypeSchema = z.enum(['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT']);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const customFieldDefinitionSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  type: customFieldTypeSchema,
  options: z.array(z.string()),
  isRequired: z.boolean(),
  position: z.number().int(),
  archivedAt: z.string().datetime().nullable(),
});

export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;

export const createCustomFieldRequestSchema = z
  .object({
    /**
     * Fixed once created. Renaming the label must not orphan the values, so
     * the machine key never changes.
     */
    key: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, numbers and underscores'),
    label: z.string().trim().min(1).max(80),
    type: customFieldTypeSchema.default('TEXT'),
    options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    isRequired: z.boolean().default(false),
    position: z.number().int().min(0).max(999).default(0),
  })
  .refine(
    (value) => value.type !== 'SELECT' || value.options.length > 0,
    'A choice field needs at least one option',
  );

export type CreateCustomFieldRequest = z.infer<typeof createCustomFieldRequestSchema>;

/** Label, options and ordering can change. Key and type cannot. */
export const updateCustomFieldRequestSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  isRequired: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});

export type UpdateCustomFieldRequest = z.infer<typeof updateCustomFieldRequestSchema>;

export const customFieldsResponseSchema = z.object({
  fields: z.array(customFieldDefinitionSchema),
});

export type CustomFieldsResponse = z.infer<typeof customFieldsResponseSchema>;

/**
 * A custom field value.
 *
 * Deliberately loose here: what is actually valid depends on this
 * organization's definitions, which only the server knows. The service builds
 * a precise schema from them and validates against that — see
 * buildCustomFieldSchema.
 */
export const customFieldValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

/**
 * Builds a validator for one organization's custom fields.
 *
 * Lives in shared so the browser can apply exactly the same rules the server
 * enforces, rather than a hand-maintained copy that drifts.
 *
 * Archived definitions are excluded, so a retired field stops accepting new
 * values while the values already stored stay untouched.
 */
export function buildCustomFieldSchema(
  definitions: CustomFieldDefinition[],
): z.ZodType<CustomFieldValues> {
  const live = definitions.filter((definition) => definition.archivedAt === null);

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const definition of live) {
    let field: z.ZodTypeAny;

    switch (definition.type) {
      case 'NUMBER':
        field = z.number({ invalid_type_error: `${definition.label} must be a number` });
        break;
      case 'BOOLEAN':
        field = z.boolean({ invalid_type_error: `${definition.label} must be true or false` });
        break;
      case 'DATE':
        field = z
          .string()
          .refine(
            (value) => !Number.isNaN(Date.parse(value)),
            `${definition.label} must be a date`,
          );
        break;
      case 'SELECT':
        field = z
          .string()
          .refine(
            (value) => definition.options.includes(value),
            `${definition.label} must be one of the available choices`,
          );
        break;
      default:
        field = z.string().max(2000, `${definition.label} is too long`);
    }

    // Required means "must be filled in", not "must be present in the
    // payload" — a partial update that does not mention the field must still
    // be accepted, so emptiness is checked rather than absence.
    shape[definition.key] = definition.isRequired ? field : field.nullable().optional();
  }

  // Unknown keys are stripped rather than rejected. A field archived between
  // the browser rendering a form and the form being submitted would otherwise
  // fail a save the user cannot fix.
  return z.object(shape).strip() as unknown as z.ZodType<CustomFieldValues>;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const TAG_COLORS = ['neutral', 'red', 'amber', 'green', 'blue', 'violet'] as const;

export const tagColorSchema = z.enum(TAG_COLORS);
export type TagColor = z.infer<typeof tagColorSchema>;

export const tagSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: tagColorSchema,
  /** How many customers carry it. Lets the interface warn before a delete. */
  customerCount: z.number().int().nonnegative().optional(),
});

export type Tag = z.infer<typeof tagSchema>;

export const createTagRequestSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: tagColorSchema.default('neutral'),
});

export type CreateTagRequest = z.infer<typeof createTagRequestSchema>;

export const updateTagRequestSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: tagColorSchema.optional(),
});

export type UpdateTagRequest = z.infer<typeof updateTagRequestSchema>;

export const tagsResponseSchema = z.object({ tags: z.array(tagSchema) });
export type TagsResponse = z.infer<typeof tagsResponseSchema>;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const contactSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isPrimary: z.boolean(),
  createdAt: z.string().datetime(),
});

export type Contact = z.infer<typeof contactSchema>;

const contactFields = {
  firstName: z.string().trim().min(1, 'A first name is required').max(80),
  lastName: optionalText(80, 'Last name'),
  title: optionalText(80, 'Title'),
  email: optionalEmail,
  phone: optionalText(40, 'Phone'),
  isPrimary: z.boolean().default(false),
};

export const createContactRequestSchema = z.object(contactFields);
export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

export const updateContactRequestSchema = z.object({
  ...contactFields,
  firstName: contactFields.firstName.optional(),
  isPrimary: z.boolean().optional(),
});

export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

export const contactsResponseSchema = z.object({ contacts: z.array(contactSchema) });
export type ContactsResponse = z.infer<typeof contactsResponseSchema>;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const customerNoteSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  body: z.string(),
  /** Null when the author has left the company. The note still stands. */
  authorName: z.string().nullable(),
  authorMembershipId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CustomerNote = z.infer<typeof customerNoteSchema>;

export const createNoteRequestSchema = z.object({
  body: z.string().trim().min(1, 'A note needs something in it').max(10000),
});

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

export const notesResponseSchema = z.object({ notes: z.array(customerNoteSchema) });
export type NotesResponse = z.infer<typeof notesResponseSchema>;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** The largest account number a business can choose. */
export const ACCOUNT_NUMBER_MAX = 99_999_999;

/** How an account number is written everywhere: #1042. */
export const formatAccountNumber = (n: number): string => `#${n}`;

export const customerSchema = z.object({
  id: z.string().uuid(),
  /** #1001, #1002, … per business. Given by the database, never reused. */
  accountNumber: z.number().int().positive(),
  stage: customerStageSchema,
  type: customerTypeSchema,
  displayName: z.string(),
  companyName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  source: z.string().nullable(),
  /** The branch that primarily serves them. Null means unassigned. */
  locationId: z.string().uuid().nullable(),
  locationName: z.string().nullable(),
  /** Additional branches, when the organization has Shared Customers. */
  sharedLocationIds: z.array(z.string().uuid()),
  ownerMembershipId: z.string().uuid().nullable(),
  ownerName: z.string().nullable(),
  customFields: customFieldValuesSchema,
  tags: z.array(tagSchema),
  convertedAt: z.string().datetime().nullable(),
  lastContactedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Customer = z.infer<typeof customerSchema>;

/** A customer with everything hanging off them. For the detail page. */
export const customerDetailSchema = customerSchema.extend({
  contacts: z.array(contactSchema),
  notes: z.array(customerNoteSchema),
});

export type CustomerDetail = z.infer<typeof customerDetailSchema>;

const customerFields = {
  type: customerTypeSchema.default('PERSON'),
  companyName: optionalText(CUSTOMER_NAME_MAX_LENGTH, 'Company name'),
  firstName: optionalText(CUSTOMER_NAME_MAX_LENGTH, 'First name'),
  lastName: optionalText(CUSTOMER_NAME_MAX_LENGTH, 'Last name'),
  email: optionalEmail,
  phone: optionalText(40, 'Phone'),
  addressLine1: optionalText(200, 'Address'),
  addressLine2: optionalText(200, 'Address'),
  city: optionalText(100, 'City'),
  region: optionalText(100, 'Region'),
  postalCode: optionalText(20, 'Postal code'),
  country: optionalText(100, 'Country'),
  source: optionalText(100, 'Source'),
  locationId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  customFields: customFieldValuesSchema.optional(),
};

/**
 * A customer needs a name, and which field carries it depends on the type.
 *
 * Checked here rather than in the service so the browser reports it on the
 * right field instead of as a generic failure after a round trip.
 */
const hasAName = (value: {
  type?: CustomerType;
  companyName?: string;
  firstName?: string;
  lastName?: string;
}) =>
  value.type === 'COMPANY'
    ? Boolean(value.companyName)
    : Boolean(value.firstName ?? value.lastName);

export const createCustomerRequestSchema = z
  .object({ ...customerFields, stage: customerStageSchema.default('LEAD') })
  .refine(hasAName, {
    message: 'A customer needs a name',
    path: ['firstName'],
  });

export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

export const updateCustomerRequestSchema = z.object({
  ...customerFields,
  companyName: clearableText(CUSTOMER_NAME_MAX_LENGTH, 'Company name'),
  firstName: clearableText(CUSTOMER_NAME_MAX_LENGTH, 'First name'),
  lastName: clearableText(CUSTOMER_NAME_MAX_LENGTH, 'Last name'),
  email: clearableEmail,
  phone: clearableText(40, 'Phone'),
  addressLine1: clearableText(200, 'Address'),
  addressLine2: clearableText(200, 'Address'),
  city: clearableText(100, 'City'),
  region: clearableText(100, 'Region'),
  postalCode: clearableText(20, 'Postal code'),
  country: clearableText(100, 'Country'),
  source: clearableText(100, 'Source'),
  /** Owners only: to match the numbers of a system the business is leaving. */
  accountNumber: z.number().int().min(1).max(ACCOUNT_NUMBER_MAX).optional(),
  type: customerTypeSchema.optional(),
  stage: customerStageSchema.optional(),
});

export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

/** Filters for the customer list. Every field optional. */
export const customerQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  stage: customerStageSchema.optional(),
  locationId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  /**
   * Archived customers are hidden unless asked for. They are not deleted, and
   * a business must be able to find one again.
   */
  includeArchived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export type CustomerQuery = z.infer<typeof customerQuerySchema>;

export const customersResponseSchema = z.object({
  customers: z.array(customerSchema),
  /** Pass back as `cursor` for the next page. Null when there are no more. */
  nextCursor: z.string().uuid().nullable(),
});

export type CustomersResponse = z.infer<typeof customersResponseSchema>;

export const customerResponseSchema = z.object({ customer: customerDetailSchema });
export type CustomerResponse = z.infer<typeof customerResponseSchema>;

export const setCustomerTagsRequestSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});

export type SetCustomerTagsRequest = z.infer<typeof setCustomerTagsRequestSchema>;

export const shareCustomerRequestSchema = z.object({
  locationIds: z.array(z.string().uuid()).max(100),
});

export type ShareCustomerRequest = z.infer<typeof shareCustomerRequestSchema>;

/** Error body when sharing is attempted without the Shared Customers module. */
export const sharingUnavailableSchema = z.object({
  statusCode: z.literal(403),
  code: z.literal('MODULE_NOT_ENABLED'),
  moduleKey: z.literal('shared_customers'),
  message: z.string(),
});
