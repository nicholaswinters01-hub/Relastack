import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext, TransactionClient } from '@platform/db';
import {
  PERMISSIONS,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type Invitation,
  type InvitationPreview,
} from '@platform/shared';
import { PasswordService } from '../auth/password.service';
import { EmailService } from '../notifications/email.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

/** Long enough to be usable, short enough that a leaked link expires. */
export const INVITATION_TTL_DAYS = 7;

export const TOKEN_BYTES = 32;

/**
 * Deliberately identical for every invalid invitation — unknown, expired,
 * revoked, or already accepted. Distinguishing them would let anyone holding a
 * malformed link probe which tokens once existed.
 */
const INVALID_INVITATION = 'This invitation is not valid or has expired';

/** Only the hash is stored, so a leaked database cannot be replayed as invitations. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
  ) {}

  /**
   * Hashed exactly like a session token, and for the same reason: the link
   * grants access to a company's data, so a stolen database must not yield a
   * working invitation. SHA-256 rather than Argon2 because the token is 256
   * bits of randomness — unguessable, so slow hashing would buy nothing while
   * making every lookup expensive.
   */
  private hashToken(token: string): string {
    return hashInvitationToken(token);
  }

  private toPublic(row: {
    id: string;
    email: string;
    scope: 'ORGANIZATION' | 'LOCATION';
    status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
    expiresAt: Date;
    createdAt: Date;
    role: { key: string; name: string };
    locations: Array<{ locationId: string }>;
  }): Invitation {
    return {
      id: row.id,
      email: row.email,
      roleKey: row.role.key,
      roleName: row.role.name,
      scope: row.scope,
      locationIds: row.locations.map((link) => link.locationId),
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Invite someone to join the organization.
   *
   * Returns the accept link once. The raw token is never stored and cannot be
   * recovered — re-inviting issues a new one.
   */
  async create(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: CreateInvitationRequest,
    baseUrl: string,
  ): Promise<{ invitation: Invitation; acceptUrl: string }> {
    // A Location Manager may invite people to the branches they run, so the
    // scope check is per-location rather than organization-wide.
    if (input.scope === 'LOCATION') {
      for (const locationId of input.locationIds) {
        if (!permissions.hasAt(PERMISSIONS.MEMBER_INVITE, locationId)) {
          throw new NotFoundException('Location not found');
        }
      }
    } else if (!permissions.has(PERMISSIONS.MEMBER_INVITE)) {
      throw new BadRequestException('You can only invite people to the locations you manage');
    }

    // Granting a role you do not hold yourself is privilege escalation. A
    // Location Manager must not be able to invite an Organization Administrator.
    if (input.roleKey === 'org_admin' && !permissions.has(PERMISSIONS.MEMBER_MANAGE)) {
      throw new BadRequestException('You cannot invite someone with more access than you have');
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitationId = randomUUID();

    const result = await this.prisma.withTenant(context, async (tx) => {
      const role = await tx.role.findFirst({ where: { key: input.roleKey } });
      if (!role) throw new NotFoundException('Role not found');

      // Locations are looked up under tenant context, so an id from another
      // organization simply is not found rather than being silently accepted.
      if (input.locationIds.length > 0) {
        const found = await tx.location.count({ where: { id: { in: input.locationIds } } });
        if (found !== input.locationIds.length) throw new NotFoundException('Location not found');
      }

      const existingMember = await tx.organizationMembership.findFirst({
        where: { user: { email: input.email } },
      });
      if (existingMember)
        throw new ConflictException('That person is already in your organization');

      // Re-inviting supersedes rather than duplicating, which is what "invite
      // again" means to a user. Also why there is no unique constraint: a
      // partial index over PENDING rows is what that would need, and a full
      // one would forbid a second revoked invitation to the same address.
      await tx.invitation.updateMany({
        where: { email: input.email, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });

      const created = await tx.invitation.create({
        data: {
          id: invitationId,
          organizationId: context.organizationId,
          email: input.email,
          tokenHash: this.hashToken(token),
          roleId: role.id,
          scope: input.scope,
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
          invitedByMembershipId: membershipId,
          locations: {
            create: input.locationIds.map((locationId) => ({
              locationId,
              organizationId: context.organizationId,
            })),
          },
        },
        include: { role: true, locations: true },
      });

      // For the email: a message naming nobody and no business reads as spam.
      const [organization, inviter] = await Promise.all([
        tx.organization.findUniqueOrThrow({
          where: { id: context.organizationId },
          select: { name: true },
        }),
        tx.organizationMembership.findUnique({
          where: { id: membershipId },
          select: { user: { select: { firstName: true, lastName: true, email: true } } },
        }),
      ]);

      return { created, organizationName: organization.name, inviter: inviter?.user ?? null };
    });

    const acceptUrl = `${baseUrl}/invitations/accept?token=${token}`;

    /*
     * Sent, at last.
     *
     * Invitations have existed since Phase 4 with no way to reach anybody —
     * the link came back in the response and somebody had to paste it into a
     * message by hand.
     *
     * Deliberately NOT through the outbox. An invitation is the direct result
     * of somebody pressing a button and watching to see it work, so a failure
     * belongs in front of them rather than retried quietly a minute later.
     * The link is still returned either way, so a provider outage degrades to
     * copying it by hand rather than to losing the invitation.
     */
    const { created: invitation, organizationName, inviter } = result;
    const inviterName =
      [inviter?.firstName, inviter?.lastName].filter(Boolean).join(' ') ||
      inviter?.email ||
      'Someone';
    // Names are free text; a line break in a subject is how headers get forged.
    const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

    try {
      await this.email.send({
        to: input.email,
        subject: oneLine(`${inviterName} invited you to join ${organizationName} on RelaStack`),
        body:
          `${inviterName} has invited you to join ${organizationName} on RelaStack, ` +
          'where the team keeps its customers, jobs and schedule.\n\n' +
          `Follow the link below to set up your account. It works for ${INVITATION_TTL_DAYS} days.`,
        link: acceptUrl,
      });
    } catch (error) {
      this.logger.error(`Could not email invitation ${invitation.id}`, error);
    }

    this.logger.log(`Invitation ${invitation.id} created for ${input.email}`);

    return { invitation: this.toPublic(invitation), acceptUrl };
  }

  async list(context: TenantContext): Promise<Invitation[]> {
    const invitations = await this.prisma.withTenant(context, (tx) =>
      tx.invitation.findMany({
        where: { status: 'PENDING' },
        include: { role: true, locations: true },
        orderBy: { createdAt: 'desc' },
      }),
    );

    return invitations.map((invitation) => this.toPublic(invitation));
  }

  async revoke(context: TenantContext, id: string): Promise<void> {
    const result = await this.prisma.withTenant(context, (tx) =>
      tx.invitation.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REVOKED' },
      }),
    );

    if (result.count === 0) throw new NotFoundException('Invitation not found');

    this.logger.log(`Invitation ${id} revoked`);
  }

  /**
   * Look up an invitation by its raw token, WITHOUT tenant context.
   *
   * Accepting necessarily happens before the invitee belongs to anything, so
   * there is no organization to scope by. The privileged path is confined to
   * this one lookup, keyed by a 256-bit unguessable token, and returns only
   * what the invitee needs to see.
   */
  private async findByToken(token: string) {
    const tokenHash = this.hashToken(token);

    // A token that is not even the right shape cannot match anything, and
    // would fail the hash-format guard in withInvitationToken.
    if (!token) return null;

    const invitation = await this.prisma.withInvitationToken(tokenHash, (tx) =>
      tx.invitation.findUnique({
        where: { tokenHash },
        // Only the role is included. Both the organization and the invitation's
        // locations are tenant-owned, and under token-only context their
        // policies hide them — an include would silently return nothing, which
        // is exactly the kind of empty-but-plausible result that produces a
        // half-granted invitation. They are fetched below, once the
        // organization is known. (System roles carry a null organization_id,
        // so the roles policy admits them here.)
        include: { role: true },
      }),
    );

    if (!invitation) return null;
    if (invitation.status !== 'PENDING') return null;
    if (invitation.expiresAt.getTime() <= Date.now()) return null;

    const { organization, locations } = await this.prisma.withOrganization(
      invitation.organizationId,
      async (tx) => ({
        organization: await tx.organization.findUnique({
          where: { id: invitation.organizationId },
        }),
        locations: await tx.invitationLocation.findMany({
          where: { invitationId: invitation.id },
        }),
      }),
    );

    // A suspended company cannot take on new people, however valid the link.
    if (!organization || organization.status !== 'ACTIVE') return null;

    return { ...invitation, organization, locations };
  }

  /** What an invitee sees before accepting. Public. */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findByToken(token);
    if (!invitation) throw new NotFoundException(INVALID_INVITATION);

    const existingUser = await this.prisma.client.user.findUnique({
      where: { email: invitation.email },
    });

    return {
      organizationName: invitation.organization.name,
      email: invitation.email,
      roleName: invitation.role.name,
      requiresAccount: existingUser === null,
    };
  }

  /**
   * Accept an invitation, creating an account if needed.
   *
   * Everything commits together: the user, the membership, the role
   * assignment, its location scope, and marking the invitation used. A partial
   * result would leave someone holding a consumed invitation and no access.
   */
  async accept(input: AcceptInvitationRequest): Promise<{ userId: string }> {
    const invitation = await this.findByToken(input.token);
    if (!invitation) throw new NotFoundException(INVALID_INVITATION);

    const existingUser = await this.prisma.client.user.findUnique({
      where: { email: invitation.email },
    });

    if (!existingUser && !input.password) {
      throw new BadRequestException('Choose a password to create your account');
    }

    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    const userId = existingUser?.id ?? randomUUID();

    await this.prisma.withTenant(
      { organizationId: invitation.organizationId, userId },
      async (tx) => {
        if (!existingUser) {
          await tx.user.create({
            data: {
              id: userId,
              email: invitation.email,
              passwordHash: passwordHash!,
              firstName: input.firstName ?? null,
              lastName: input.lastName ?? null,
            },
          });
        }

        await this.grantMembership(tx, invitation, userId);

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
      },
    );

    this.logger.log(`Invitation ${invitation.id} accepted by user ${userId}`);

    return { userId };
  }

  private async grantMembership(
    tx: TransactionClient,
    invitation: {
      id: string;
      organizationId: string;
      roleId: string;
      scope: 'ORGANIZATION' | 'LOCATION';
      locations: Array<{ locationId: string }>;
    },
    userId: string,
  ): Promise<void> {
    const membership = await tx.organizationMembership.upsert({
      where: { userId_organizationId: { userId, organizationId: invitation.organizationId } },
      // The legacy column is still written so a rollback would not strand
      // this member. It is dropped once nothing reads it.
      create: { userId, organizationId: invitation.organizationId, role: 'MEMBER' },
      update: {},
    });

    const assignment = await tx.membershipRole.upsert({
      where: {
        membershipId_roleId_scope: {
          membershipId: membership.id,
          roleId: invitation.roleId,
          scope: invitation.scope,
        },
      },
      create: {
        membershipId: membership.id,
        roleId: invitation.roleId,
        scope: invitation.scope,
        organizationId: invitation.organizationId,
      },
      update: {},
    });

    for (const link of invitation.locations) {
      await tx.membershipRoleLocation.upsert({
        where: {
          membershipRoleId_locationId: {
            membershipRoleId: assignment.id,
            locationId: link.locationId,
          },
        },
        create: {
          membershipRoleId: assignment.id,
          locationId: link.locationId,
          organizationId: invitation.organizationId,
        },
        update: {},
      });

      // Staffing follows permission, so the new member appears in the
      // location's people list rather than only in its permission tables.
      await tx.locationMembership.upsert({
        where: {
          membershipId_locationId: { membershipId: membership.id, locationId: link.locationId },
        },
        create: {
          membershipId: membership.id,
          locationId: link.locationId,
          organizationId: invitation.organizationId,
        },
        update: {},
      });
    }
  }
}
