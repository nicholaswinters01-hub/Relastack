import { Injectable, Logger } from '@nestjs/common';
import type { OrganizationMembership, TenantContext } from '@platform/db';
import { PrismaService } from '../prisma/prisma.service';

export type ResolvedMembership = OrganizationMembership;

/**
 * Resolves which organization a request acts on.
 *
 * Deliberately resolved from membership on EVERY request rather than cached on
 * the session. Caching would save a query, at the cost of a removed employee
 * retaining access until their session happened to expire. Immediate
 * revocation is the whole reason sessions were chosen over stateless tokens;
 * caching the organization here would give that property back up.
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's active membership, or null if they belong to no organization.
   *
   * Runs under user-only context: the RLS policy permits a caller to read
   * their own membership rows, which is exactly — and only — what is needed
   * before an organization is known.
   */
  async resolveMembership(userId: string): Promise<ResolvedMembership | null> {
    const memberships = await this.prisma.withUserOnly(userId, (tx) =>
      tx.organizationMembership.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    );

    const membership = memberships[0];
    if (!membership) return null;

    if (memberships.length > 1) {
      // Multi-organization membership is supported by the schema but has no UI
      // for choosing between them yet. Taking the earliest is a placeholder,
      // and worth knowing about if it ever happens before that UI exists.
      this.logger.warn(
        `User ${userId} belongs to ${memberships.length} organizations; using the earliest.`,
      );
    }

    return membership;
  }

  /**
   * Confirm the organization is usable, under its own tenant context.
   *
   * A suspended organization must not be able to act, regardless of how valid
   * its members' sessions are.
   */
  async isOrganizationActive(context: TenantContext): Promise<boolean> {
    const organization = await this.prisma.withTenant(context, (tx) =>
      tx.organization.findUnique({ where: { id: context.organizationId } }),
    );

    return organization?.status === 'ACTIVE';
  }
}
