import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import type { Contact, CreateContactRequest, UpdateContactRequest } from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

type ContactRow = Prisma.ContactGetPayload<Record<string, never>>;

/**
 * People at a customer.
 *
 * Scope is enforced by the caller: every route here goes through the
 * customer, and CustomersService decides whether that customer is reachable.
 * Duplicating the visibility rule in a second place is how the two drift.
 */
@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  static toPublic(row: ContactRow): Contact {
    return {
      id: row.id,
      customerId: row.customerId,
      firstName: row.firstName,
      lastName: row.lastName,
      title: row.title,
      email: row.email,
      phone: row.phone,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async create(
    context: TenantContext,
    customerId: string,
    input: CreateContactRequest,
  ): Promise<Contact> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      // At most one primary. Enforced here rather than by a constraint,
      // because a partial unique index cannot express "at most one true"
      // without also forbidding a second false.
      if (input.isPrimary) {
        await tx.contact.updateMany({ where: { customerId }, data: { isPrimary: false } });
      }

      return tx.contact.create({
        data: {
          organizationId: context.organizationId,
          customerId,
          firstName: input.firstName,
          lastName: input.lastName ?? null,
          title: input.title ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          isPrimary: input.isPrimary,
        },
      });
    });

    return ContactsService.toPublic(row);
  }

  async update(
    context: TenantContext,
    customerId: string,
    contactId: string,
    input: UpdateContactRequest,
  ): Promise<Contact> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const existing = await tx.contact.findFirst({ where: { id: contactId, customerId } });

      if (!existing) throw new NotFoundException('Contact not found');

      if (input.isPrimary) {
        await tx.contact.updateMany({
          where: { customerId, id: { not: contactId } },
          data: { isPrimary: false },
        });
      }

      return tx.contact.update({
        where: { id: contactId },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName ?? null } : {}),
          ...(input.title !== undefined ? { title: input.title ?? null } : {}),
          ...(input.email !== undefined ? { email: input.email ?? null } : {}),
          ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
          ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        },
      });
    });

    return ContactsService.toPublic(row);
  }

  async remove(context: TenantContext, customerId: string, contactId: string): Promise<void> {
    const deleted = await this.prisma.withTenant(context, (tx) =>
      tx.contact.deleteMany({ where: { id: contactId, customerId } }),
    );

    if (deleted.count === 0) throw new NotFoundException('Contact not found');
  }

  async listFor(context: TenantContext, customerId: string): Promise<Contact[]> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.contact.findMany({
        where: { customerId },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
    );

    return rows.map(ContactsService.toPublic);
  }
}
