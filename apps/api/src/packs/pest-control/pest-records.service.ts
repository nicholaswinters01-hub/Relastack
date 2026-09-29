import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma, TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  pestTreatmentRecordSchema,
  type PestRecord,
  type PestRecordsQuery,
} from '@platform/shared';
import { csvCell } from '../../common/csv';
import { PrismaService } from '../../prisma/prisma.service';
import type { PermissionSet } from '../../rbac/permission-set';

/** Enough for a year of a busy branch; an export beyond it should be narrowed. */
const RECORD_LIMIT = 10_000;

const CSV_COLUMNS = [
  'Date',
  'Time',
  'Time zone',
  'Customer',
  'Address',
  'Job',
  'Branch',
  'Product',
  'EPA Reg. No.',
  'Active ingredient',
  'Amount',
  'Unit',
  'Mix rate',
  'Target pests',
  'Areas treated',
  'Method',
  'Applicator',
  'License',
  'License expires',
  'Wind (mph)',
  'Temperature (F)',
  'Taken from',
  'Voided',
] as const;

/**
 * Pest application records: every product applied on every visit.
 *
 * Read through the schedule's own visibility rule, so a branch manager's
 * export is their branches' records, and through the customer rule, so a
 * record never names a customer the reader may not see.
 */
@Injectable()
export class PestRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    query: PestRecordsQuery,
  ): Promise<PestRecord[]> {
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException('The start date is after the end date');
    }

    const jobScope = permissions.locationsFor(PERMISSIONS.JOB_READ);
    const jobVisible: Prisma.JobWhereInput =
      jobScope === null
        ? {}
        : {
            OR: [
              { locationId: { in: [...jobScope] } },
              { assignments: { some: { membershipId } } },
            ],
          };
    const customerScope = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);

    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.stockMovement.findMany({
        where: {
          reason: 'USED',
          job: {
            AND: [
              jobVisible,
              query.customerId ? { customerId: query.customerId } : {},
              query.jobId ? { id: query.jobId } : {},
            ],
          },
          createdAt: {
            ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
            ...(query.to ? { lt: nextDay(query.to) } : {}),
          },
        },
        include: {
          item: { select: { unit: true } },
          place: {
            select: {
              location: { select: { name: true } },
              fleetAsset: { select: { name: true } },
            },
          },
          voidedBy: { select: { id: true } },
          job: {
            select: {
              id: true,
              title: true,
              customerId: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              region: true,
              postalCode: true,
              location: { select: { name: true, timezone: true } },
              customer: { select: { displayName: true, locationId: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: RECORD_LIMIT,
      }),
    );

    const records: PestRecord[] = [];
    for (const row of rows) {
      const fields = (row.packFields as Record<string, unknown>)[MODULES.PEST_CONTROL];
      const treatment = pestTreatmentRecordSchema.safeParse(fields);
      if (!treatment.success || !row.job) continue;

      const customer = row.job.customer;
      const customerVisible =
        customer === null ||
        customerScope === null ||
        (customer.locationId !== null && customerScope.has(customer.locationId));

      records.push({
        movementId: row.id,
        jobId: row.job.id,
        jobTitle: row.job.title,
        appliedAt: row.createdAt.toISOString(),
        customerId: customerVisible ? row.job.customerId : null,
        customerName: customerVisible ? (customer?.displayName ?? null) : null,
        // The address is where the work was done, and goes with the customer.
        address: customerVisible ? addressOf(row.job) : null,
        locationName: row.job.location?.name ?? null,
        timezone: row.job.location?.timezone ?? null,
        quantity: row.quantity.negated().toNumber(),
        unit: row.item.unit,
        placeName: row.place.fleetAsset?.name ?? row.place.location.name,
        treatment: treatment.data,
        voided: row.voidedBy !== null,
      });
    }
    return records;
  }

  async csv(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    query: PestRecordsQuery,
  ): Promise<string> {
    const records = await this.list(context, permissions, membershipId, query);
    const lines = [CSV_COLUMNS.join(',')];
    for (const record of [...records].reverse()) {
      const t = record.treatment;
      lines.push(
        [
          ...localDateTime(record.appliedAt, record.timezone ?? 'UTC'),
          record.timezone ?? 'UTC',
          record.customerName ?? '',
          record.address ?? '',
          record.jobTitle,
          record.locationName ?? '',
          t.productName,
          t.epaRegistrationNumber ?? '',
          t.activeIngredient ?? '',
          String(record.quantity),
          record.unit,
          t.mixRate ?? '',
          t.targetPests.join('; '),
          t.areas.join('; '),
          t.method,
          t.applicatorName,
          t.applicatorLicense ?? '',
          t.applicatorLicenseExpiresOn ?? '',
          t.windMph == null ? '' : String(t.windMph),
          t.temperatureF == null ? '' : String(t.temperatureF),
          record.placeName,
          record.voided ? 'Voided' : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return `${lines.join('\r\n')}\r\n`;
  }
}

/** A date and time as the branch reads them: the day an inspector asks about. */
function localDateTime(iso: string, timeZone: string): [string, string] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return [`${get('year')}-${get('month')}-${get('day')}`, `${get('hour')}:${get('minute')}`];
}

function nextDay(isoDay: string): Date {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function addressOf(job: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
}): string | null {
  const street = [job.addressLine1, job.addressLine2].filter(Boolean).join(' ');
  const place = [job.city, [job.region, job.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [street, place].filter(Boolean).join(', ') || null;
}
