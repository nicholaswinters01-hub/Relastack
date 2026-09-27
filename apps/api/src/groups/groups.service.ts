import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext, TransactionClient } from '@platform/db';
import type {
  CreateGroupRequest,
  GroupColor,
  MemberGroup,
  UpdateGroupRequest,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

const NOT_FOUND = 'Group not found';

/**
 * Employee groups: labels a business gives its people.
 *
 * Deliberately powerless. Nothing in the permission or visibility code reads
 * a group, and nothing should: roles decide what someone may do, locations
 * where. A test proves joining a group grants nothing.
 */
@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(context: TenantContext): Promise<MemberGroup[]> {
    const groups = await this.prisma.withTenant(context, (tx) =>
      tx.memberGroup.findMany({
        include: { _count: { select: { members: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );

    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color as GroupColor,
      memberCount: group._count.members,
    }));
  }

  async create(context: TenantContext, input: CreateGroupRequest): Promise<MemberGroup> {
    const group = await this.prisma.withTenant(context, async (tx) => {
      await this.assertNameFree(tx, input.name, null);
      const last = await tx.memberGroup.aggregate({ _max: { sortOrder: true } });

      return tx.memberGroup.create({
        data: {
          organizationId: context.organizationId,
          name: input.name,
          color: input.color,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });
    });

    return { id: group.id, name: group.name, color: group.color as GroupColor, memberCount: 0 };
  }

  async update(context: TenantContext, id: string, input: UpdateGroupRequest): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      await this.load(tx, id);
      if (input.name !== undefined) await this.assertNameFree(tx, input.name, id);

      await tx.memberGroup.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
        },
      });
    });
  }

  /** Removes the label only. People, roles and everything else stay as they were. */
  async remove(context: TenantContext, id: string): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      await this.load(tx, id);
      await tx.memberGroup.delete({ where: { id } });
    });
  }

  /** Replaces a person's groups with exactly these. */
  async setMemberGroups(
    context: TenantContext,
    membershipId: string,
    groupIds: string[],
  ): Promise<string[]> {
    const wanted = [...new Set(groupIds)];

    return this.prisma.withTenant(context, async (tx) => {
      // RLS hides another business's people and groups, so a foreign id is
      // simply not found: 404, never a hint that it exists elsewhere.
      const member = await tx.organizationMembership.findFirst({
        where: { id: membershipId },
        select: { id: true },
      });
      if (!member) throw new NotFoundException('Person not found');

      const found = await tx.memberGroup.count({ where: { id: { in: wanted } } });
      if (found !== wanted.length) throw new NotFoundException(NOT_FOUND);

      await tx.memberGroupMember.deleteMany({
        where: { membershipId, groupId: { notIn: wanted } },
      });
      await tx.memberGroupMember.createMany({
        data: wanted.map((groupId) => ({
          groupId,
          membershipId,
          organizationId: context.organizationId,
        })),
        skipDuplicates: true,
      });

      return wanted;
    });
  }

  // -------------------------------------------------------------------------

  private async load(tx: TransactionClient, id: string) {
    const group = await tx.memberGroup.findFirst({ where: { id }, select: { id: true } });
    if (!group) throw new NotFoundException(NOT_FOUND);
    return group;
  }

  /**
   * Checked before writing rather than by catching the unique index: an error
   * inside a PostgreSQL transaction aborts the whole transaction.
   */
  private async assertNameFree(tx: TransactionClient, name: string, exceptId: string | null) {
    const clash = await tx.memberGroup.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`There is already a group called "${name.trim()}"`);
  }
}
