import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth';
import { roleScopeSchema } from './permission';

/**
 * Invitation contracts.
 *
 * How employees get into an organization. Self-registration always creates a
 * NEW business, so there is deliberately no path by which someone joins an
 * existing one uninvited.
 */

export const invitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REVOKED']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const createInvitationRequestSchema = z
  .object({
    email: emailSchema,
    roleKey: z.string().min(1, 'Choose a role'),
    scope: roleScopeSchema,
    locationIds: z.array(z.string().uuid()).default([]),
  })
  .refine((data) => data.scope === 'ORGANIZATION' || data.locationIds.length > 0, {
    message: 'A location-scoped invitation must name at least one location',
    path: ['locationIds'],
  })
  .refine((data) => data.scope === 'LOCATION' || data.locationIds.length === 0, {
    // Ignoring them silently would make the request appear to do something it
    // did not.
    message: 'An organization-scoped invitation cannot name locations',
    path: ['locationIds'],
  });

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  scope: roleScopeSchema,
  locationIds: z.array(z.string().uuid()),
  status: invitationStatusSchema,
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type Invitation = z.infer<typeof invitationSchema>;

/**
 * The created invitation, plus its one-time link.
 *
 * `acceptUrl` is returned exactly once, at creation, and never again — the
 * token behind it is stored only as a hash. Until Phase 11 delivers email,
 * this is how an owner gets the link to their colleague.
 */
export const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
  acceptUrl: z.string(),
});

export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

export const invitationsResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});

export type InvitationsResponse = z.infer<typeof invitationsResponseSchema>;

/** What an invitee sees before accepting, without needing an account. */
export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  roleName: z.string(),
  /** True when the address already has an account, so the form can adapt. */
  requiresAccount: z.boolean(),
});

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1, 'This invitation link is not valid'),
  /**
   * Required only when the invitee has no account yet. Verified against the
   * invitation server-side; a client claiming otherwise changes nothing.
   */
  password: passwordSchema.optional(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
