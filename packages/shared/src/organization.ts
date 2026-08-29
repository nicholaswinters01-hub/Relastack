import { z } from 'zod';
import { resolvedPermissionsSchema, roleAssignmentSchema } from './permission';

/**
 * Organization contracts.
 *
 * An organization is the tenant boundary — the unit of isolation and, per the
 * commercial model, the thing a subscription attaches to.
 */

export const organizationStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;

export const organizationRoleSchema = z.enum(['OWNER', 'MEMBER']);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const ORGANIZATION_NAME_MIN_LENGTH = 2;
export const ORGANIZATION_NAME_MAX_LENGTH = 120;

export const organizationNameSchema = z
  .string()
  .trim()
  .min(ORGANIZATION_NAME_MIN_LENGTH, 'Organization name is too short')
  .max(ORGANIZATION_NAME_MAX_LENGTH, 'Organization name is too long');

export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: organizationStatusSchema,
  createdAt: z.string().datetime(),
});

export type Organization = z.infer<typeof organizationSchema>;

export const updateOrganizationRequestSchema = z.object({
  name: organizationNameSchema,
});

export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

/**
 * A member as seen by their colleagues.
 *
 * Contains no credential material and no cross-organization information — a
 * member listing must not become a way to learn what else a user belongs to.
 */
export const organizationMemberSchema = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  roles: z.array(roleAssignmentSchema),
  joinedAt: z.string().datetime(),
});

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const organizationResponseSchema = z.object({
  organization: organizationSchema,
  /** Role keys the caller holds, e.g. ['org_admin']. Display only. */
  roles: z.array(z.string()),
  /**
   * What the caller may actually do.
   *
   * Sent so the web app can hide controls the user cannot use. That is a
   * usability affordance, never a security control — the API enforces the same
   * rules regardless of what the browser renders.
   */
  permissions: resolvedPermissionsSchema,
  /**
   * The caller's own membership id.
   *
   * Sent so the interface can tell which notes and records are theirs. Neither
   * secret nor an authorization input — the API decides authorship, and this
   * only changes what the browser offers.
   */
  membershipId: z.string().uuid(),
});

export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;

export const organizationMembersResponseSchema = z.object({
  members: z.array(organizationMemberSchema),
});

export type OrganizationMembersResponse = z.infer<typeof organizationMembersResponseSchema>;
