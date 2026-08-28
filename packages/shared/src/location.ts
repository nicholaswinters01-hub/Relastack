import { z } from 'zod';

/**
 * Location contracts.
 *
 * A location is a physical place of business, and the unit the platform is
 * priced by. Phase 6 counts these; nothing here may make user count a billing
 * input.
 */

export const locationStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type LocationStatus = z.infer<typeof locationStatusSchema>;

export const LOCATION_NAME_MIN_LENGTH = 2;
export const LOCATION_NAME_MAX_LENGTH = 120;

export const locationNameSchema = z
  .string()
  .trim()
  .min(LOCATION_NAME_MIN_LENGTH, 'Location name is too short')
  .max(LOCATION_NAME_MAX_LENGTH, 'Location name is too long');

/** Optional free-text field: blank is stored as absent, not as "". */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .optional()
  .transform((value) => (value === '' ? undefined : value))
  .refine(
    (value) => value === undefined || z.string().email().safeParse(value).success,
    'Enter a valid email address',
  );

/**
 * IANA zone identifier, e.g. "America/New_York".
 *
 * Validated against the runtime's own timezone database rather than a
 * hard-coded list, which would go stale as zones change. Appointment times in
 * Phase 9 are meaningless without a correct zone.
 */
export const timezoneSchema = z
  .string()
  .trim()
  .default('UTC')
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Enter a valid IANA timezone, for example America/New_York');

export const locationSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string(),
  status: locationStatusSchema,
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type Location = z.infer<typeof locationSchema>;

const locationFields = {
  name: locationNameSchema,
  addressLine1: optionalText(200, 'Address'),
  addressLine2: optionalText(200, 'Address'),
  city: optionalText(100, 'City'),
  region: optionalText(100, 'Region'),
  postalCode: optionalText(20, 'Postal code'),
  country: optionalText(100, 'Country'),
  phone: optionalText(40, 'Phone'),
  email: optionalEmail,
  timezone: timezoneSchema,
};

export const createLocationRequestSchema = z.object(locationFields);
export type CreateLocationRequest = z.infer<typeof createLocationRequestSchema>;

export const updateLocationRequestSchema = z.object({
  ...locationFields,
  status: locationStatusSchema.optional(),
});
export type UpdateLocationRequest = z.infer<typeof updateLocationRequestSchema>;

export const assignLocationMemberRequestSchema = z.object({
  /**
   * An OrganizationMembership id, not a user id.
   *
   * Location access only means anything inside an organization, so assignment
   * goes through membership. It also means a caller cannot name a user from
   * another company: that user has no membership in this organization to
   * reference.
   */
  membershipId: z.string().uuid(),
});
export type AssignLocationMemberRequest = z.infer<typeof assignLocationMemberRequestSchema>;

export const locationMemberSchema = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  assignedAt: z.string().datetime(),
});

export type LocationMember = z.infer<typeof locationMemberSchema>;

export const locationResponseSchema = z.object({ location: locationSchema });
export const locationsResponseSchema = z.object({ locations: z.array(locationSchema) });
export const locationMembersResponseSchema = z.object({
  members: z.array(locationMemberSchema),
});

export type LocationResponse = z.infer<typeof locationResponseSchema>;
export type LocationsResponse = z.infer<typeof locationsResponseSchema>;
export type LocationMembersResponse = z.infer<typeof locationMembersResponseSchema>;
