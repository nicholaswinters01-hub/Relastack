import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma, TenantContext } from '@platform/db';
import { PERMISSIONS } from '@platform/shared';
import { csvFile } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';
import { customerVisibility } from './customer-visibility';

export type ExportKind = 'customers' | 'contacts' | 'notes';

const nameOf = (
  user: { firstName: string | null; lastName: string | null; email: string } | null | undefined,
) => (user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : '');

/** A day as the customer's branch reads it; UTC for a customer with no branch. */
function dayIn(date: Date | null, timeZone: string | null | undefined): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join('; ');
  return String(value);
}

/**
 * A business's customers, contacts and notes as spreadsheets, so it can
 * always leave with its own records — including when its subscription has
 * lapsed, since these are reads.
 *
 * Exporting is its own permission (customer.export): reading customers one at
 * a time is not the same as walking out with all of them. Where it is held
 * decides which customers are in the file, by the same three-way rule as the
 * customer list. Column names match what the importer recognises, so a file
 * goes back in unchanged.
 */
@Injectable()
export class CustomerExportService {
  constructor(private readonly prisma: PrismaService) {}

  async csv(context: TenantContext, permissions: PermissionSet, kind: ExportKind): Promise<string> {
    if (!permissions.hasAnywhere(PERMISSIONS.CUSTOMER_EXPORT)) {
      throw new ForbiddenException('You do not have permission to export customers');
    }
    const where: Prisma.CustomerWhereInput = customerVisibility(
      permissions,
      PERMISSIONS.CUSTOMER_EXPORT,
    );

    return this.prisma.withTenant(context, async (tx) => {
      if (kind === 'contacts') {
        const contacts = await tx.contact.findMany({
          where: { customer: where },
          include: { customer: { select: { accountNumber: true, displayName: true } } },
          orderBy: [{ customer: { accountNumber: 'asc' } }, { createdAt: 'asc' }],
        });
        return csvFile(
          [
            'Account number',
            'Customer',
            'First name',
            'Last name',
            'Title',
            'Email',
            'Phone',
            'Primary',
          ],
          contacts.map((contact) => [
            fieldValue(contact.customer.accountNumber),
            contact.customer.displayName,
            contact.firstName,
            contact.lastName ?? '',
            contact.title ?? '',
            contact.email ?? '',
            contact.phone ?? '',
            contact.isPrimary ? 'Yes' : 'No',
          ]),
        );
      }

      if (kind === 'notes') {
        const notes = await tx.customerNote.findMany({
          where: { customer: where },
          include: {
            customer: {
              select: {
                accountNumber: true,
                displayName: true,
                location: { select: { timezone: true } },
              },
            },
            author: {
              select: { user: { select: { firstName: true, lastName: true, email: true } } },
            },
          },
          orderBy: [{ customer: { accountNumber: 'asc' } }, { createdAt: 'asc' }],
        });
        return csvFile(
          ['Account number', 'Customer', 'Date', 'Author', 'Note'],
          notes.map((note) => [
            fieldValue(note.customer.accountNumber),
            note.customer.displayName,
            dayIn(note.createdAt, note.customer.location?.timezone),
            nameOf(note.author?.user),
            note.body,
          ]),
        );
      }

      const [customers, fields] = await Promise.all([
        tx.customer.findMany({
          where,
          include: {
            location: { select: { name: true, timezone: true } },
            ownerMembership: {
              select: { user: { select: { firstName: true, lastName: true, email: true } } },
            },
            tags: { select: { tag: { select: { name: true } } } },
          },
          orderBy: [{ accountNumber: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.customFieldDefinition.findMany({
          where: { entity: 'CUSTOMER', archivedAt: null },
          orderBy: { position: 'asc' },
          select: { key: true, label: true },
        }),
      ]);
      return csvFile(
        [
          'Account number',
          'Display name',
          'Type',
          'Stage',
          'First name',
          'Last name',
          'Company',
          'Email',
          'Phone',
          'Address',
          'Address 2',
          'City',
          'State',
          'ZIP',
          'Country',
          'Source',
          'Branch',
          'Owner',
          'Tags',
          'Created',
          'Became a customer',
          'Last contacted',
          ...fields.map((field) => field.label),
        ],
        customers.map((customer) => {
          const zone = customer.location?.timezone;
          const custom = (customer.customFields ?? {}) as Record<string, unknown>;
          return [
            fieldValue(customer.accountNumber),
            customer.displayName,
            customer.type === 'COMPANY' ? 'Company' : 'Person',
            customer.stage.charAt(0) + customer.stage.slice(1).toLowerCase(),
            customer.firstName ?? '',
            customer.lastName ?? '',
            customer.companyName ?? '',
            customer.email ?? '',
            customer.phone ?? '',
            customer.addressLine1 ?? '',
            customer.addressLine2 ?? '',
            customer.city ?? '',
            customer.region ?? '',
            customer.postalCode ?? '',
            customer.country ?? '',
            customer.source ?? '',
            customer.location?.name ?? '',
            nameOf(customer.ownerMembership?.user),
            customer.tags.map((entry) => entry.tag.name).join('; '),
            dayIn(customer.createdAt, zone),
            dayIn(customer.convertedAt, zone),
            dayIn(customer.lastContactedAt, zone),
            ...fields.map((field) => fieldValue(custom[field.key])),
          ];
        }),
      );
    });
  }
}
