import { z } from 'zod';

/**
 * Permission catalogue.
 *
 * Keys are stable strings, matched by the seed migration. Code refers to these
 * constants rather than string literals, so a typo is a compile error instead
 * of a permission that is silently never granted — the worst kind of security
 * bug, because it fails open in the direction of "check never matched".
 */
export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_WRITE: 'organization.write',
  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  MEMBER_MANAGE: 'member.manage',
  LOCATION_READ: 'location.read',
  LOCATION_WRITE: 'location.write',
  LOCATION_ASSIGN: 'location.assign',
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  CUSTOMER_DELETE: 'customer.delete',
  /**
   * Defining a custom field or renaming a tag changes the shape of the data
   * for everyone in the company, so it is separated from day-to-day writing.
   */
  CUSTOMER_CONFIGURE: 'customer.configure',
  TASK_READ: 'task.read',
  TASK_WRITE: 'task.write',
  TASK_DELETE: 'task.delete',
  JOB_READ: 'job.read',
  JOB_WRITE: 'job.write',
  JOB_DELETE: 'job.delete',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionKey[];

/** System role keys, seeded once and shared by every organization. */
export const SYSTEM_ROLES = {
  ORG_ADMIN: 'org_admin',
  LOCATION_MANAGER: 'location_manager',
  EMPLOYEE: 'employee',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/**
 * Fixed UUIDs for the system roles, matching the seed migration.
 *
 * Hard-coded rather than looked up by key so that registration can create an
 * owner's role assignment inside the same transaction as the organization,
 * without an extra round-trip and without a failure mode where the lookup
 * misses and a new owner silently ends up with no permissions at all.
 */
export const SYSTEM_ROLE_IDS: Record<SystemRoleKey, string> = {
  org_admin: '00000000-0000-4000-a000-000000000001',
  location_manager: '00000000-0000-4000-a000-000000000002',
  employee: '00000000-0000-4000-a000-000000000003',
};

export const roleScopeSchema = z.enum(['ORGANIZATION', 'LOCATION']);
export type RoleScope = z.infer<typeof roleScopeSchema>;

export const roleSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultScope: roleScopeSchema,
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});

export type Role = z.infer<typeof roleSchema>;

/**
 * A role held by a member, and where it applies.
 *
 * `locationIds` is empty for ORGANIZATION scope — the assignment reaches
 * everywhere, so enumerating locations would be both redundant and wrong the
 * moment a new location is added.
 */
export const roleAssignmentSchema = z.object({
  id: z.string().uuid(),
  roleKey: z.string(),
  roleName: z.string(),
  scope: roleScopeSchema,
  locationIds: z.array(z.string().uuid()),
});

export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

/**
 * What the current caller may do.
 *
 * `organizationWide` holds permissions granted everywhere. `byLocation` holds
 * those granted only at specific locations. A permission may appear in both:
 * an org-wide Employee who is also Location Manager at one branch.
 */
export const resolvedPermissionsSchema = z.object({
  organizationWide: z.array(z.string()),
  byLocation: z.record(z.string(), z.array(z.string())),
  roles: z.array(z.string()),
});

export type ResolvedPermissions = z.infer<typeof resolvedPermissionsSchema>;

export const assignRoleRequestSchema = z
  .object({
    membershipId: z.string().uuid(),
    roleKey: z.string().min(1),
    scope: roleScopeSchema,
    locationIds: z.array(z.string().uuid()).default([]),
  })
  .refine((data) => data.scope === 'ORGANIZATION' || data.locationIds.length > 0, {
    message: 'A location-scoped role must name at least one location',
    path: ['locationIds'],
  })
  .refine((data) => data.scope === 'LOCATION' || data.locationIds.length === 0, {
    // Silently ignoring them would make the request look like it did something
    // it did not.
    message: 'An organization-scoped role cannot name locations',
    path: ['locationIds'],
  });

export type AssignRoleRequest = z.infer<typeof assignRoleRequestSchema>;

export const createCustomRoleRequestSchema = z.object({
  /** Machine identifier. Lower-case, no spaces, so it reads like a system key. */
  key: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, numbers and underscores'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  defaultScope: roleScopeSchema,
  permissions: z.array(z.string()).min(1, 'Choose at least one permission'),
});

export type CreateCustomRoleRequest = z.infer<typeof createCustomRoleRequestSchema>;

export const rolesResponseSchema = z.object({ roles: z.array(roleSchema) });
export type RolesResponse = z.infer<typeof rolesResponseSchema>;

export const permissionsResponseSchema = z.object({ permissions: resolvedPermissionsSchema });
export type PermissionsResponse = z.infer<typeof permissionsResponseSchema>;
