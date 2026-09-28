import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext, type TransactionClient } from '@platform/db';
import {
  PERMISSIONS,
  type AssetDetailResponse,
  type CompleteServiceRequest,
  type CreateAssetRequest,
  type CreateReminderRequest,
  type FleetAsset,
  type FleetMeter,
  type FleetReminder,
  type FleetResponse,
  type LogReadingRequest,
  type ReminderState,
  type SetJobVehicleRequest,
  type UpdateAssetRequest,
} from '@platform/shared';
import type { PermissionSet } from '../rbac/permission-set';
import { PrismaService } from '../prisma/prisma.service';

const ASSET_NOT_FOUND = 'Vehicle or equipment not found';
const HISTORY_LIMIT = 100;
/** A dated reminder is "due soon" this many days ahead. */
const SOON_DAYS = 30;

type Decimal = Prisma.Decimal;
const decimal = (value: number) => new Prisma.Decimal(value.toString());

const ASSET_INCLUDE = {
  location: { select: { name: true, timezone: true } },
  assigned: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
  reminders: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } },
  stockPlace: { select: { id: true } },
} as const;

type AssetRow = Prisma.FleetAssetGetPayload<{ include: typeof ASSET_INCLUDE }>;
type ReminderRow = AssetRow['reminders'][number];
type LatestReading = { value: Decimal; readOn: Date };

const nameOf = (person?: { firstName: string | null; lastName: string | null; email: string }) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email : null;

/** A date column as YYYY-MM-DD. Dates are days, never instants. */
const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Today where the asset is kept, so "due today" means the branch's today. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addMonths(isoDay: string, months: number): string {
  const [year, month, date] = isoDay.split('-').map(Number) as [number, number, number];
  // Clamp to the month's last day, so 31 January plus one month is 28 or 29 February.
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return day(target);
}

const carriesStock = (kind: string) => kind === 'VEHICLE' || kind === 'TRAILER';

/**
 * Fleet: vehicles and equipment, their readings, and the service they are due.
 *
 * Authority follows the asset's home branch, like stock does: managing needs
 * fleet.write there, reading needs fleet.read there. The usual driver may
 * also see their vehicle and log its readings wherever it is kept, because
 * the person with the keys is the one who knows the odometer.
 *
 * A vehicle or trailer is a stock place as well. It is created here, in the
 * same transaction as the asset, and follows the asset's home branch.
 */
@Injectable()
export class FleetService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    includeRetired: boolean,
  ): Promise<FleetResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const rows = await tx.fleetAsset.findMany({
        where: {
          AND: [
            this.visibilityFilter(permissions, membershipId),
            includeRetired ? {} : { status: { not: 'RETIRED' } },
          ],
        },
        include: ASSET_INCLUDE,
        orderBy: [{ location: { name: 'asc' } }, { name: 'asc' }],
      });
      const latest = await this.latestReadings(
        tx,
        rows.map((row) => row.id),
      );

      return {
        assets: rows.map((row) => this.toAsset(row, latest.get(row.id), permissions, membershipId)),
      };
    });
  }

  async detail(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
  ): Promise<AssetDetailResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const row = await this.loadAsset(tx, permissions, membershipId, assetId);
      const [readings, services] = await Promise.all([
        tx.fleetReading.findMany({
          where: { assetId },
          orderBy: [{ readOn: 'desc' }, { createdAt: 'desc' }],
          take: HISTORY_LIMIT,
        }),
        tx.fleetServiceRecord.findMany({
          where: { assetId },
          orderBy: [{ doneOn: 'desc' }, { createdAt: 'desc' }],
          take: HISTORY_LIMIT,
        }),
      ]);
      const latest = readings[0];

      return {
        asset: this.toAsset(row, latest, permissions, membershipId),
        readings: readings.map((reading) => ({
          id: reading.id,
          value: reading.value.toNumber(),
          readOn: day(reading.readOn),
          recordedByName: reading.recordedByName,
        })),
        services: services.map((service) => ({
          id: service.id,
          title: service.title,
          doneOn: day(service.doneOn),
          reading: service.reading?.toNumber() ?? null,
          costCents: service.costCents,
          note: service.note,
          recordedByName: service.recordedByName,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: CreateAssetRequest,
  ): Promise<FleetAsset> {
    return this.prisma.withTenant(context, async (tx) => {
      await this.assertBranch(tx, permissions, input.locationId);
      await this.assertNameFree(tx, input.name, null);
      if (input.assignedMembershipId) await this.assertMember(tx, input.assignedMembershipId);

      const asset = await tx.fleetAsset.create({
        data: {
          organizationId: context.organizationId,
          locationId: input.locationId,
          name: input.name,
          kind: input.kind,
          make: input.make ?? null,
          model: input.model ?? null,
          year: input.year ?? null,
          plate: input.plate ?? null,
          identifier: input.identifier ?? null,
          meter: input.meter,
          notes: input.notes ?? null,
          assignedMembershipId: input.assignedMembershipId ?? null,
        },
      });

      if (carriesStock(input.kind)) {
        await tx.stockPlace.create({
          data: {
            organizationId: context.organizationId,
            kind: 'VEHICLE',
            locationId: input.locationId,
            fleetAssetId: asset.id,
          },
        });
      }

      if (input.initialReading != null && input.meter !== 'NONE') {
        const row = await tx.fleetAsset.findUniqueOrThrow({
          where: { id: asset.id },
          select: { location: { select: { timezone: true } } },
        });
        await tx.fleetReading.create({
          data: {
            organizationId: context.organizationId,
            assetId: asset.id,
            value: decimal(input.initialReading),
            readOn: asDate(todayIn(row.location.timezone)),
            recordedById: membershipId,
            recordedByName: await this.nameOfMember(tx, membershipId),
          },
        });
      }

      const created = await tx.fleetAsset.findUniqueOrThrow({
        where: { id: asset.id },
        include: ASSET_INCLUDE,
      });
      const latest = await this.latestReadings(tx, [asset.id]);
      return this.toAsset(created, latest.get(asset.id), permissions, membershipId);
    });
  }

  async update(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
    input: UpdateAssetRequest,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const current = await this.loadAsset(tx, permissions, membershipId, assetId);
      this.assertManage(permissions, current);

      if (input.kind !== undefined && input.kind !== current.kind) {
        throw new BadRequestException(
          'What kind of asset it is cannot change. Retire it and add it again.',
        );
      }
      const moving = input.locationId !== undefined && input.locationId !== current.locationId;
      if (moving) await this.assertBranch(tx, permissions, input.locationId!);

      const status = input.status ?? current.status;
      if (status !== 'RETIRED' && (input.name !== undefined || current.status === 'RETIRED')) {
        await this.assertNameFree(tx, input.name ?? current.name, assetId);
      }
      if (input.assignedMembershipId) await this.assertMember(tx, input.assignedMembershipId);

      await tx.fleetAsset.update({
        where: { id: assetId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(moving ? { locationId: input.locationId } : {}),
          ...(input.make !== undefined ? { make: input.make } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.year !== undefined ? { year: input.year } : {}),
          ...(input.plate !== undefined ? { plate: input.plate } : {}),
          ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
          ...(input.meter !== undefined ? { meter: input.meter } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.assignedMembershipId !== undefined
            ? { assignedMembershipId: input.assignedMembershipId }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });

      // The van's stock moves branch with the van, so whoever manages its new
      // home branch manages what is on it.
      if (moving && current.stockPlace) {
        await tx.stockPlace.update({
          where: { id: current.stockPlace.id },
          data: { locationId: input.locationId },
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Readings
  // -------------------------------------------------------------------------

  /**
   * Log what the meter says.
   *
   * A reading below the last one answers 409 READING_LOWER: odometers do not
   * go backwards, so it is usually a typo. Resubmitting with
   * `acknowledgeLower` records it anyway, for a replaced meter or a wrong
   * earlier reading.
   */
  async logReading(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
    input: LogReadingRequest,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const asset = await this.loadAsset(tx, permissions, membershipId, assetId);
      if (!this.canLogReadings(permissions, membershipId, asset)) {
        throw new ForbiddenException('Only a manager or its usual driver can log readings');
      }
      if (asset.meter === 'NONE') {
        throw new BadRequestException(`${asset.name} has no meter to read`);
      }

      const latest = (await this.latestReadings(tx, [assetId])).get(assetId);
      if (latest && decimal(input.value).lessThan(latest.value) && !input.acknowledgeLower) {
        throw new ConflictException({
          statusCode: 409,
          code: 'READING_LOWER',
          message: `The last reading was ${latest.value.toNumber()} on ${day(latest.readOn)}. This one is lower.`,
          latest: latest.value.toNumber(),
        });
      }

      await tx.fleetReading.create({
        data: {
          organizationId: context.organizationId,
          assetId,
          value: decimal(input.value),
          readOn: asDate(input.readOn ?? todayIn(asset.location.timezone)),
          recordedById: membershipId,
          recordedByName: await this.nameOfMember(tx, membershipId),
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Reminders and service
  // -------------------------------------------------------------------------

  async createReminder(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
    input: CreateReminderRequest,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const asset = await this.loadAsset(tx, permissions, membershipId, assetId);
      this.assertManage(permissions, asset);
      if (
        asset.meter === 'NONE' &&
        (input.intervalReading != null || input.nextDueReading != null)
      ) {
        throw new BadRequestException(`${asset.name} has no meter, so give months or a date`);
      }

      const today = todayIn(asset.location.timezone);
      const latest = (await this.latestReadings(tx, [assetId])).get(assetId);
      const nextDueOn =
        input.nextDueOn ?? (input.intervalMonths ? addMonths(today, input.intervalMonths) : null);
      const nextDueReading =
        input.nextDueReading ??
        (input.intervalReading ? (latest?.value.toNumber() ?? 0) + input.intervalReading : null);

      await tx.fleetReminder.create({
        data: {
          organizationId: context.organizationId,
          assetId,
          title: input.title,
          intervalMonths: input.intervalMonths ?? null,
          intervalReading: input.intervalReading == null ? null : decimal(input.intervalReading),
          nextDueOn: nextDueOn ? asDate(nextDueOn) : null,
          nextDueReading: nextDueReading == null ? null : decimal(nextDueReading),
        },
      });
    });
  }

  async removeReminder(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    reminderId: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const reminder = await tx.fleetReminder.findFirst({
        where: { id: reminderId, archivedAt: null },
        select: { assetId: true },
      });
      if (!reminder) throw new NotFoundException('Reminder not found');
      const asset = await this.loadAsset(tx, permissions, membershipId, reminder.assetId);
      this.assertManage(permissions, asset);

      await tx.fleetReminder.update({
        where: { id: reminderId },
        data: { archivedAt: new Date() },
      });
    });
  }

  /**
   * Record service that was done, and move its reminder on.
   *
   * A repeating reminder becomes due one interval after the day and reading
   * it was actually done, not after it was due: an oil change done late
   * starts the next 5,000 miles from when it was done. A one-off reminder
   * (a date and nothing else) is finished.
   */
  async completeService(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
    input: CompleteServiceRequest,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const asset = await this.loadAsset(tx, permissions, membershipId, assetId);
      this.assertManage(permissions, asset);

      const reminder = input.reminderId
        ? asset.reminders.find((entry) => entry.id === input.reminderId)
        : undefined;
      if (input.reminderId && !reminder) throw new NotFoundException('Reminder not found');
      const title = input.title ?? reminder?.title;
      if (!title) throw new BadRequestException('Say what the service was');

      const doneOn = input.doneOn ?? todayIn(asset.location.timezone);
      const latest = (await this.latestReadings(tx, [assetId])).get(assetId);
      const reading =
        input.reading ?? (asset.meter === 'NONE' ? null : (latest?.value.toNumber() ?? null));
      const recordedByName = await this.nameOfMember(tx, membershipId);

      await tx.fleetServiceRecord.create({
        data: {
          organizationId: context.organizationId,
          assetId,
          reminderId: reminder?.id ?? null,
          title,
          doneOn: asDate(doneOn),
          reading: reading == null ? null : decimal(reading),
          costCents: input.costCents ?? null,
          note: input.note ?? null,
          recordedById: membershipId,
          recordedByName,
        },
      });

      // A reading taken at the service is a reading like any other.
      if (
        input.reading != null &&
        asset.meter !== 'NONE' &&
        (!latest || decimal(input.reading).greaterThan(latest.value))
      ) {
        await tx.fleetReading.create({
          data: {
            organizationId: context.organizationId,
            assetId,
            value: decimal(input.reading),
            readOn: asDate(doneOn),
            recordedById: membershipId,
            recordedByName,
          },
        });
      }

      if (reminder) {
        const repeats = reminder.intervalMonths !== null || reminder.intervalReading !== null;
        await tx.fleetReminder.update({
          where: { id: reminder.id },
          data: repeats
            ? {
                nextDueOn: reminder.intervalMonths
                  ? asDate(addMonths(doneOn, reminder.intervalMonths))
                  : null,
                nextDueReading:
                  reminder.intervalReading && reading !== null
                    ? decimal(reading).plus(reminder.intervalReading)
                    : reminder.intervalReading
                      ? reminder.nextDueReading
                      : null,
              }
            : { archivedAt: new Date() },
        });
      }
    });
  }

  async removeService(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    serviceId: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const service = await tx.fleetServiceRecord.findUnique({
        where: { id: serviceId },
        select: { assetId: true },
      });
      if (!service) throw new NotFoundException('Service record not found');
      const asset = await this.loadAsset(tx, permissions, membershipId, service.assetId);
      this.assertManage(permissions, asset);

      await tx.fleetServiceRecord.delete({ where: { id: serviceId } });
    });
  }

  // -------------------------------------------------------------------------
  // A vehicle on a job
  // -------------------------------------------------------------------------

  /**
   * Name the vehicle a job's crew takes, or clear it.
   *
   * Booking a vehicle that is already out on an overlapping job answers 409
   * VEHICLE_CONFLICT, and `acknowledgeConflicts` books it anyway, the same as
   * crew conflicts. The clash names times, not the other job: it may sit at a
   * branch the reader cannot see.
   */
  async setJobVehicle(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
    input: SetJobVehicleRequest,
  ): Promise<{ vehicleId: string | null; vehicleName: string | null }> {
    return this.prisma.withTenant(context, async (tx) => {
      const job = await tx.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          locationId: true,
          startsAt: true,
          endsAt: true,
          assignments: { select: { membershipId: true } },
        },
      });
      const onCrew = job?.assignments.some((entry) => entry.membershipId === membershipId);
      const canSee =
        job &&
        (onCrew ||
          (job.locationId === null
            ? permissions.has(PERMISSIONS.JOB_READ)
            : permissions.hasAt(PERMISSIONS.JOB_READ, job.locationId)));
      if (!job || !canSee) throw new NotFoundException('Job not found');

      const canWrite =
        job.locationId === null
          ? permissions.has(PERMISSIONS.JOB_WRITE)
          : permissions.hasAt(PERMISSIONS.JOB_WRITE, job.locationId);
      if (!canWrite) throw new ForbiddenException('You do not have permission to change this job');

      if (input.vehicleId === null) {
        await tx.job.update({ where: { id: jobId }, data: { vehicleId: null } });
        return { vehicleId: null, vehicleName: null };
      }

      const vehicle = await tx.fleetAsset.findFirst({
        where: { AND: [{ id: input.vehicleId }, this.visibilityFilter(permissions, membershipId)] },
        select: { id: true, name: true, status: true },
      });
      if (!vehicle) throw new NotFoundException('That vehicle does not exist');
      if (vehicle.status === 'RETIRED') {
        throw new BadRequestException(`${vehicle.name} is retired`);
      }

      if (!input.acknowledgeConflicts) {
        const clashes = await tx.job.findMany({
          where: {
            vehicleId: vehicle.id,
            id: { not: jobId },
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
            startsAt: { lt: job.endsAt },
            endsAt: { gt: job.startsAt },
          },
          select: { startsAt: true, endsAt: true },
          orderBy: { startsAt: 'asc' },
        });
        if (clashes.length > 0) {
          throw new ConflictException({
            statusCode: 409,
            code: 'VEHICLE_CONFLICT',
            message: `${vehicle.name} is already booked on ${clashes.length === 1 ? 'another job' : `${clashes.length} other jobs`} then.`,
            conflicts: clashes.map((clash) => ({
              startsAt: clash.startsAt.toISOString(),
              endsAt: clash.endsAt.toISOString(),
            })),
          });
        }
      }

      await tx.job.update({ where: { id: jobId }, data: { vehicleId: vehicle.id } });
      return { vehicleId: vehicle.id, vehicleName: vehicle.name };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** At a branch the reader can see, or the reader's own vehicle. */
  private visibilityFilter(
    permissions: PermissionSet,
    membershipId: string,
  ): Prisma.FleetAssetWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.FLEET_READ);
    if (allowed === null) return {};
    return {
      OR: [{ locationId: { in: [...allowed] } }, { assignedMembershipId: membershipId }],
    };
  }

  private async loadAsset(
    tx: TransactionClient,
    permissions: PermissionSet,
    membershipId: string,
    assetId: string,
  ): Promise<AssetRow> {
    const asset = await tx.fleetAsset.findFirst({
      where: { AND: [{ id: assetId }, this.visibilityFilter(permissions, membershipId)] },
      include: ASSET_INCLUDE,
    });
    if (!asset) throw new NotFoundException(ASSET_NOT_FOUND);
    return asset;
  }

  private canManage(permissions: PermissionSet, asset: { locationId: string }): boolean {
    return permissions.hasAt(PERMISSIONS.FLEET_WRITE, asset.locationId);
  }

  private canLogReadings(
    permissions: PermissionSet,
    membershipId: string,
    asset: { locationId: string; assignedMembershipId: string | null },
  ): boolean {
    return this.canManage(permissions, asset) || asset.assignedMembershipId === membershipId;
  }

  private assertManage(permissions: PermissionSet, asset: AssetRow): void {
    if (!this.canManage(permissions, asset)) {
      throw new ForbiddenException(`Only a manager of ${asset.location.name} can do that`);
    }
  }

  /** A branch the reader manages fleet at; 404 for one they cannot see at all. */
  private async assertBranch(
    tx: TransactionClient,
    permissions: PermissionSet,
    locationId: string,
  ): Promise<void> {
    const location = await tx.location.findUnique({
      where: { id: locationId },
      select: { id: true, name: true },
    });
    if (!location || !permissions.hasAt(PERMISSIONS.FLEET_READ, locationId)) {
      throw new NotFoundException('That location does not exist');
    }
    if (!permissions.hasAt(PERMISSIONS.FLEET_WRITE, locationId)) {
      throw new ForbiddenException(`Only a manager of ${location.name} can add vehicles there`);
    }
  }

  private async assertMember(tx: TransactionClient, membershipId: string): Promise<void> {
    const member = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { id: true },
    });
    if (!member) throw new BadRequestException('That person is not in this business');
  }

  private async assertNameFree(
    tx: TransactionClient,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.fleetAsset.findFirst({
      where: {
        AND: [
          { name: { equals: name, mode: 'insensitive' }, status: { not: 'RETIRED' } },
          exceptId ? { NOT: { id: exceptId } } : {},
        ],
      },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(`There is already a vehicle or equipment called "${name}"`);
  }

  private async latestReadings(
    tx: TransactionClient,
    assetIds: string[],
  ): Promise<Map<string, LatestReading>> {
    if (assetIds.length === 0) return new Map();
    const rows = await tx.fleetReading.findMany({
      where: { assetId: { in: assetIds } },
      distinct: ['assetId'],
      orderBy: [{ assetId: 'asc' }, { readOn: 'desc' }, { createdAt: 'desc' }],
      select: { assetId: true, value: true, readOn: true },
    });
    return new Map(rows.map((row) => [row.assetId, { value: row.value, readOn: row.readOn }]));
  }

  private async nameOfMember(tx: TransactionClient, membershipId: string): Promise<string> {
    const membership = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    return nameOf(membership?.user) ?? 'Someone';
  }

  private reminderState(
    reminder: ReminderRow,
    today: string,
    reading: number | null,
    meter: FleetMeter,
  ): ReminderState {
    let state: ReminderState = 'OK';
    const worse = (next: ReminderState) => {
      if (next === 'OVERDUE' || (next === 'DUE_SOON' && state === 'OK')) state = next;
    };

    if (reminder.nextDueOn) {
      const due = day(reminder.nextDueOn);
      if (due <= today) worse('OVERDUE');
      else if (due <= addDays(today, SOON_DAYS)) worse('DUE_SOON');
    }
    if (reminder.nextDueReading && reading !== null) {
      const due = reminder.nextDueReading.toNumber();
      const window = reminder.intervalReading
        ? reminder.intervalReading.toNumber() * 0.1
        : meter === 'HOURS'
          ? 25
          : 500;
      if (reading >= due) worse('OVERDUE');
      else if (reading >= due - window) worse('DUE_SOON');
    }
    return state;
  }

  private toReminder(
    reminder: ReminderRow,
    today: string,
    reading: number | null,
    meter: FleetMeter,
  ): FleetReminder {
    return {
      id: reminder.id,
      title: reminder.title,
      intervalMonths: reminder.intervalMonths,
      intervalReading: reminder.intervalReading?.toNumber() ?? null,
      nextDueOn: reminder.nextDueOn ? day(reminder.nextDueOn) : null,
      nextDueReading: reminder.nextDueReading?.toNumber() ?? null,
      state: this.reminderState(reminder, today, reading, meter),
    };
  }

  private toAsset(
    row: AssetRow,
    latest: LatestReading | undefined,
    permissions: PermissionSet,
    membershipId: string,
  ): FleetAsset {
    const today = todayIn(row.location.timezone);
    const reading = latest?.value.toNumber() ?? null;
    // A retired asset is due nothing.
    const reminders =
      row.status === 'RETIRED'
        ? []
        : row.reminders.map((reminder) => this.toReminder(reminder, today, reading, row.meter));
    const serviceState: ReminderState = reminders.some((r) => r.state === 'OVERDUE')
      ? 'OVERDUE'
      : reminders.some((r) => r.state === 'DUE_SOON')
        ? 'DUE_SOON'
        : 'OK';

    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      locationId: row.locationId,
      locationName: row.location.name,
      make: row.make,
      model: row.model,
      year: row.year,
      plate: row.plate,
      identifier: row.identifier,
      meter: row.meter,
      assignedMembershipId: row.assignedMembershipId,
      assignedName: nameOf(row.assigned?.user),
      notes: row.notes,
      reading,
      readingOn: latest ? day(latest.readOn) : null,
      serviceState,
      reminders,
      stockPlaceId: row.stockPlace?.id ?? null,
      canManage: this.canManage(permissions, row),
      canLogReadings: row.meter !== 'NONE' && this.canLogReadings(permissions, membershipId, row),
    };
  }
}

function addDays(isoDay: string, days: number): string {
  const date = asDate(isoDay);
  date.setUTCDate(date.getUTCDate() + days);
  return day(date);
}
