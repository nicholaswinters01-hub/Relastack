import { z } from 'zod';
import { organizationStatusSchema } from './organization';
import { subscriptionStatusSchema } from './subscription';

/**
 * The staff console: the people who run RelaStack, helping the businesses on it.
 *
 * Account information only. Nothing here describes what a business keeps about
 * its own customers, and the database refuses staff access to those tables
 * whatever an endpoint might ask for.
 */

/** Every change a staff member makes says why. It lands in the audit trail. */
export const staffReasonSchema = z
  .string()
  .trim()
  .min(5, 'Say briefly why (at least 5 characters)')
  .max(500);

export const staffOverviewSchema = z.object({
  businesses: z.number().int().nonnegative(),
  trialing: z.number().int().nonnegative(),
  trialsEndingThisWeek: z.number().int().nonnegative(),
  paying: z.number().int().nonnegative(),
  pastDue: z.number().int().nonnegative(),
  readOnly: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  /** Plan + locations + add-ons for paying businesses, before any credits. */
  estimatedMonthlyRevenueCents: z.number().int().nonnegative(),
});
export type StaffOverview = z.infer<typeof staffOverviewSchema>;

export const staffBusinessFilterSchema = z.enum([
  'all',
  'trialing',
  'trial-ending',
  'past-due',
  'read-only',
  'suspended',
]);
export type StaffBusinessFilter = z.infer<typeof staffBusinessFilterSchema>;

export const staffBusinessQuerySchema = z.object({
  /** Business name or any member's email. */
  search: z.string().trim().max(120).optional(),
  filter: staffBusinessFilterSchema.default('all'),
});
export type StaffBusinessQuery = z.infer<typeof staffBusinessQuerySchema>;

export const staffBusinessSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: organizationStatusSchema,
  createdAt: z.string().datetime(),
  planName: z.string().nullable(),
  subscriptionStatus: subscriptionStatusSchema.nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  locationCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  ownerEmail: z.string().nullable(),
  /** The most recent sign-in or session use by anyone in the business. */
  lastActiveAt: z.string().datetime().nullable(),
});
export type StaffBusinessSummary = z.infer<typeof staffBusinessSummarySchema>;

export const staffBusinessesResponseSchema = z.object({
  businesses: z.array(staffBusinessSummarySchema),
});
export type StaffBusinessesResponse = z.infer<typeof staffBusinessesResponseSchema>;

export const staffAuditEventSchema = z.object({
  id: z.string().uuid(),
  staffEmail: z.string(),
  organizationId: z.string().uuid().nullable(),
  action: z.string(),
  reason: z.string().nullable(),
  details: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type StaffAuditEvent = z.infer<typeof staffAuditEventSchema>;

export const staffBusinessDetailSchema = z.object({
  business: z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    status: organizationStatusSchema,
    createdAt: z.string().datetime(),
  }),
  subscription: z
    .object({
      planKey: z.string(),
      planName: z.string(),
      /** What is stored. */
      status: subscriptionStatusSchema,
      /** What the business is actually experiencing right now. */
      effectiveStatus: subscriptionStatusSchema,
      accessLevel: z.enum(['full', 'read-only']),
      trialEndsAt: z.string().datetime().nullable(),
      periodStartsAt: z.string().datetime(),
      periodEndsAt: z.string().datetime(),
      graceEndsAt: z.string().datetime().nullable(),
      cancelledAt: z.string().datetime().nullable(),
      monthlyChargeCents: z.number().int().nonnegative(),
      addOns: z.array(z.object({ moduleKey: z.string(), priceCents: z.number().int() })),
    })
    .nullable(),
  locations: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      city: z.string().nullable(),
      region: z.string().nullable(),
      status: z.string(),
    }),
  ),
  members: z.array(
    z.object({
      userId: z.string().uuid(),
      email: z.string(),
      name: z.string().nullable(),
      role: z.enum(['OWNER', 'MEMBER']),
      userStatus: z.enum(['ACTIVE', 'SUSPENDED']),
      lastLoginAt: z.string().datetime().nullable(),
      /** Set while sign-in is locked after too many wrong passwords. */
      lockedUntil: z.string().datetime().nullable(),
      failedLoginAttempts: z.number().int().nonnegative(),
      activeSessions: z.number().int().nonnegative(),
    }),
  ),
  modules: z.array(z.object({ key: z.string(), enabled: z.boolean() })),
  invitations: z.array(
    z.object({
      id: z.string().uuid(),
      email: z.string(),
      status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED']),
      expiresAt: z.string().datetime(),
      createdAt: z.string().datetime(),
    }),
  ),
  notes: z.array(
    z.object({
      id: z.string().uuid(),
      body: z.string(),
      authorEmail: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
  /** Staff activity on this business, newest first. */
  activity: z.array(staffAuditEventSchema),
  /** For the change-plan control. */
  plans: z.array(
    z.object({ key: z.string(), name: z.string(), maxLocations: z.number().int().nullable() }),
  ),
});
export type StaffBusinessDetail = z.infer<typeof staffBusinessDetailSchema>;

export const extendTrialRequestSchema = z.object({
  until: z.string().datetime({ offset: true }),
  reason: staffReasonSchema,
});
export type ExtendTrialRequest = z.infer<typeof extendTrialRequestSchema>;

export const staffChangePlanRequestSchema = z.object({
  planKey: z.string().min(1),
  reason: staffReasonSchema,
});
export type StaffChangePlanRequest = z.infer<typeof staffChangePlanRequestSchema>;

export const setBusinessStatusRequestSchema = z.object({
  status: organizationStatusSchema,
  reason: staffReasonSchema,
});
export type SetBusinessStatusRequest = z.infer<typeof setBusinessStatusRequestSchema>;

/** Unlock sign-in, sign out everywhere, re-issue an invitation link. */
export const staffActionRequestSchema = z.object({ reason: staffReasonSchema });
export type StaffActionRequest = z.infer<typeof staffActionRequestSchema>;

export const reissueInvitationResponseSchema = z.object({ acceptUrl: z.string().url() });
export type ReissueInvitationResponse = z.infer<typeof reissueInvitationResponseSchema>;

export const addStaffNoteRequestSchema = z.object({
  body: z.string().trim().min(1, 'Write something').max(5000),
});
export type AddStaffNoteRequest = z.infer<typeof addStaffNoteRequestSchema>;

export const staffAuditResponseSchema = z.object({ events: z.array(staffAuditEventSchema) });
export type StaffAuditResponse = z.infer<typeof staffAuditResponseSchema>;
