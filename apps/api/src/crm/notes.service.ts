import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import { PERMISSIONS, type CustomerNote } from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const NOTE_INCLUDE = {
  author: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
} as const;

type NoteRow = Prisma.CustomerNoteGetPayload<{ include: typeof NOTE_INCLUDE }>;

/**
 * The record of what was said to a customer.
 *
 * Notes are attributed but not owned: the author is nullable, so a note
 * survives the person who wrote it leaving the company. Losing the history of
 * a customer relationship because an employee left would be worse than useless.
 */
@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  static toPublic(row: NoteRow): CustomerNote {
    const author = row.author?.user;

    return {
      id: row.id,
      customerId: row.customerId,
      body: row.body,
      authorName: author
        ? [author.firstName, author.lastName].filter(Boolean).join(' ') || author.email
        : null,
      authorMembershipId: row.authorMembershipId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listFor(context: TenantContext, customerId: string): Promise<CustomerNote[]> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.customerNote.findMany({
        where: { customerId },
        include: NOTE_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );

    return rows.map(NotesService.toPublic);
  }

  async create(
    context: TenantContext,
    customerId: string,
    membershipId: string,
    body: string,
  ): Promise<CustomerNote> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const created = await tx.customerNote.create({
        data: {
          organizationId: context.organizationId,
          customerId,
          authorMembershipId: membershipId,
          body,
        },
        include: NOTE_INCLUDE,
      });

      // Writing a note IS contact. Keeping this in step automatically is the
      // difference between a field that means something and one everybody
      // ignores because it is always stale.
      await tx.customer.update({
        where: { id: customerId },
        data: { lastContactedAt: new Date() },
      });

      return created;
    });

    return NotesService.toPublic(row);
  }

  /**
   * Only the author may edit a note, unless the caller manages members.
   *
   * A note is somebody's account of a conversation they had. Letting a
   * colleague quietly rewrite it would make the whole history untrustworthy.
   */
  async update(
    context: TenantContext,
    permissions: PermissionSet,
    customerId: string,
    noteId: string,
    membershipId: string,
    body: string,
  ): Promise<CustomerNote> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const existing = await tx.customerNote.findFirst({ where: { id: noteId, customerId } });

      if (!existing) throw new NotFoundException('Note not found');

      const isAuthor = existing.authorMembershipId === membershipId;

      if (!isAuthor && !permissions.has(PERMISSIONS.MEMBER_MANAGE)) {
        throw new ForbiddenException('Only the author can edit this note');
      }

      return tx.customerNote.update({
        where: { id: noteId },
        data: { body },
        include: NOTE_INCLUDE,
      });
    });

    return NotesService.toPublic(row);
  }

  async remove(
    context: TenantContext,
    permissions: PermissionSet,
    customerId: string,
    noteId: string,
    membershipId: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const existing = await tx.customerNote.findFirst({ where: { id: noteId, customerId } });

      if (!existing) throw new NotFoundException('Note not found');

      const isAuthor = existing.authorMembershipId === membershipId;

      if (!isAuthor && !permissions.has(PERMISSIONS.MEMBER_MANAGE)) {
        throw new ForbiddenException('Only the author can delete this note');
      }

      await tx.customerNote.delete({ where: { id: noteId } });
    });
  }
}
