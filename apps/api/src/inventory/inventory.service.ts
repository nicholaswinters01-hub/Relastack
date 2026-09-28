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
  type CreateItemRequest,
  type InventoryItem,
  type InventoryResponse,
  type ItemDetailResponse,
  type StockChangeRequest,
  type StockChangeResponse,
  type StockMovement,
  type StockPlace,
  type UpdateItemRequest,
  type UpdatePlaceRequest,
  MODULES,
  type JobMaterial,
  type JobMaterialsResponse,
  type PestTreatmentFields,
  type RecordJobMaterialRequest,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import type { PermissionSet } from '../rbac/permission-set';
import { PrismaService } from '../prisma/prisma.service';
import { loadJobAccess, type JobAccess } from '../common/job-access';
import { checkPackFields } from '../packs/pack-fields';
import { enrichPestTreatment } from '../packs/pest-control/pest-enrich';

const ITEM_NOT_FOUND = 'Item not found';
const PLACE_NOT_FOUND = 'That place does not exist';
const HISTORY_LIMIT = 200;

type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);
const decimal = (value: number) => new Prisma.Decimal(value.toString());

type PlaceRow = {
  id: string;
  kind: 'BRANCH' | 'VEHICLE';
  locationId: string;
  employeesCanTake: boolean;
  location: { name: string; status: 'ACTIVE' | 'INACTIVE' };
  fleetAsset: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'IN_SHOP' | 'RETIRED';
    assignedMembershipId: string | null;
  } | null;
};

/** A van is called by its own name; a branch by the branch's. */
const placeName = (place: PlaceRow) => place.fleetAsset?.name ?? place.location.name;

type ItemRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  costCents: number | null;
  lowStockLevel: Decimal | null;
  archivedAt: Date | null;
  packFields: Prisma.JsonValue;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const placeSelect = {
  id: true,
  kind: true,
  locationId: true,
  employeesCanTake: true,
  location: { select: { name: true, status: true } },
  fleetAsset: { select: { id: true, name: true, status: true, assignedMembershipId: true } },
} as const;

/**
 * Inventory: items, the places stock sits, and the ledger of every change.
 *
 * On hand is always the sum of the ledger at the places the reader can see.
 * A Location Manager's numbers are their branches' numbers, never the
 * company's: an aggregate is still a disclosure.
 *
 * Authority over stock follows the branch a place belongs to. Managing
 * (receive, count, correct, the branch setting) needs inventory.write there.
 * Taking (use, move) needs the same, or the branch's own "employees can take
 * stock" setting plus being able to see that branch. The setting is read here
 * and nowhere else, so it can never reach beyond inventory. A van's usual
 * driver may also take stock from their own van, wherever it is kept.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async overview(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    includeArchived: boolean,
  ): Promise<InventoryResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const places = await this.visiblePlaces(tx, permissions, membershipId);
      const items = await tx.inventoryItem.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: { name: 'asc' },
      });
      const totals = await this.totals(
        tx,
        places.map((place) => place.id),
        null,
      );

      return {
        items: items.map((item) => this.toItem(item, totals.get(item.id))),
        places: places.map((place) => this.toPlace(place, permissions, membershipId)),
      };
    });
  }

  async item(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    itemId: string,
  ): Promise<ItemDetailResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);

      const places = await this.visiblePlaces(tx, permissions, membershipId);
      const placeIds = places.map((place) => place.id);
      const totals = await this.totals(tx, placeIds, itemId);
      const names = new Map(places.map((place) => [place.id, placeName(place)]));

      const movements = await tx.stockMovement.findMany({
        where: { itemId, placeId: { in: placeIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: HISTORY_LIMIT,
      });

      return {
        item: this.toItem(item, totals.get(item.id)),
        places: places.map((place) => this.toPlace(place, permissions, membershipId)),
        movements: movements.map((row): StockMovement => ({
          id: row.id,
          itemId: row.itemId,
          placeId: row.placeId,
          placeName: names.get(row.placeId) ?? '',
          quantity: row.quantity.toNumber(),
          reason: row.reason,
          countedQuantity: row.countedQuantity?.toNumber() ?? null,
          transferId: row.transferId,
          note: row.note,
          recordedByName: row.recordedByName,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async createItem(
    context: TenantContext,
    enabledModules: ReadonlySet<string>,
    input: CreateItemRequest,
  ): Promise<InventoryItem> {
    const packFields = checkPackFields('item', input.packFields, {}, enabledModules, 'merge');
    const item = await this.prisma.withTenant(context, async (tx) => {
      await this.assertUnique(tx, input.name, input.sku ?? null, null);

      return tx.inventoryItem.create({
        data: {
          organizationId: context.organizationId,
          name: input.name,
          sku: input.sku ?? null,
          unit: input.unit,
          category: input.category ?? null,
          costCents: input.costCents ?? null,
          lowStockLevel:
            input.lowStockLevel === undefined || input.lowStockLevel === null
              ? null
              : decimal(input.lowStockLevel),
          packFields: packFields as Prisma.InputJsonValue,
        },
      });
    });

    return this.toItem(item, undefined);
  }

  async updateItem(
    context: TenantContext,
    enabledModules: ReadonlySet<string>,
    itemId: string,
    input: UpdateItemRequest,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const current = await tx.inventoryItem.findUnique({ where: { id: itemId } });
      if (!current) throw new NotFoundException(ITEM_NOT_FOUND);

      const archiving = input.archived ?? current.archivedAt !== null;
      // Bringing an item back, or renaming a live one, must not collide with a
      // live item that took the name meanwhile.
      if (!archiving) {
        await this.assertUnique(
          tx,
          input.name ?? current.name,
          input.sku === undefined ? current.sku : input.sku,
          itemId,
        );
      } else if (input.sku !== undefined && input.sku !== null) {
        await this.assertUnique(tx, null, input.sku, itemId);
      }

      await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sku !== undefined ? { sku: input.sku } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
          ...(input.lowStockLevel !== undefined
            ? {
                lowStockLevel: input.lowStockLevel === null ? null : decimal(input.lowStockLevel),
              }
            : {}),
          ...(input.archived !== undefined
            ? { archivedAt: input.archived ? (current.archivedAt ?? new Date()) : null }
            : {}),
          // Merged over what the item already has, inside this transaction.
          ...(input.packFields !== undefined
            ? {
                packFields: checkPackFields(
                  'item',
                  input.packFields,
                  current.packFields,
                  enabledModules,
                  'merge',
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------

  async updatePlace(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    placeId: string,
    input: UpdatePlaceRequest,
  ): Promise<StockPlace> {
    return this.prisma.withTenant(context, async (tx) => {
      const place = await this.loadPlace(tx, permissions, membershipId, placeId);

      if (!permissions.hasAt(PERMISSIONS.INVENTORY_WRITE, place.locationId)) {
        throw new ForbiddenException('Only a manager of this branch can change that');
      }

      const updated = await tx.stockPlace.update({
        where: { id: placeId },
        data: { employeesCanTake: input.employeesCanTake },
        select: placeSelect,
      });

      return this.toPlace(updated, permissions, membershipId);
    });
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  /**
   * Record one change to stock.
   *
   * Taking stock below zero answers 409 STOCK_BELOW_ZERO, naming what is on
   * hand; resubmitting with `acknowledgeNegative` records it anyway. Product
   * really is used before the delivery is entered, and refusing would only
   * push people to type in the wrong numbers.
   */
  async change(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: StockChangeRequest,
  ): Promise<StockChangeResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: input.itemId } });
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);
      if (item.archivedAt) {
        throw new BadRequestException(
          'That item is archived. Bring it back to record stock for it.',
        );
      }

      const place = await this.loadPlace(tx, permissions, membershipId, input.placeId);
      const toPlace =
        input.action === 'move'
          ? await this.loadPlace(tx, permissions, membershipId, input.toPlaceId)
          : null;
      if (toPlace && toPlace.id === place.id) {
        throw new BadRequestException('Choose a different place to move it to');
      }

      const taking = input.action === 'use' || input.action === 'move';
      for (const target of toPlace ? [place, toPlace] : [place]) {
        this.assertAuthority(permissions, membershipId, target, taking);
      }

      // Serialise changes to this item at these places, so a count and a use
      // arriving together cannot both be computed from the same starting sum.
      for (const id of [place.id, toPlace?.id].filter((x): x is string => !!x).sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${item.id}:${id}`}, 0))`;
      }

      const onHand = await this.onHandAt(tx, item.id, place.id);
      const recordedByName = await this.nameOf(tx, membershipId);
      const base = {
        organizationId: context.organizationId,
        itemId: item.id,
        note: input.note?.trim() || null,
        recordedById: membershipId,
        recordedByName,
      };

      let delta: Decimal;
      switch (input.action) {
        case 'receive':
          delta = decimal(input.quantity);
          break;
        case 'use':
        case 'damaged':
        case 'move':
          delta = decimal(input.quantity).negated();
          break;
        case 'count':
          delta = decimal(input.counted).minus(onHand);
          break;
        case 'correct':
          delta = decimal(input.change);
          break;
      }

      const after = onHand.plus(delta);
      const warns = input.action !== 'receive' && input.action !== 'count';
      if (warns && delta.isNegative() && after.isNegative() && !input.acknowledgeNegative) {
        throw new ConflictException({
          statusCode: 409,
          code: 'STOCK_BELOW_ZERO',
          message: `${placeName(place)} has ${onHand.toNumber()} ${item.unit} of ${item.name}. This would leave ${after.toNumber()}.`,
          onHand: onHand.toNumber(),
          after: after.toNumber(),
        });
      }

      if (input.action === 'move') {
        if (!toPlace) throw new BadRequestException('Choose where to move it to');
        const transferId = randomUUID();
        await tx.stockMovement.createMany({
          data: [
            { ...base, placeId: place.id, quantity: delta, reason: 'MOVED_OUT', transferId },
            {
              ...base,
              placeId: toPlace.id,
              quantity: delta.negated(),
              reason: 'MOVED_IN',
              transferId,
            },
          ],
        });

        return {
          onHand: [
            { placeId: place.id, onHand: after.toNumber() },
            {
              placeId: toPlace.id,
              onHand: (await this.onHandAt(tx, item.id, toPlace.id)).toNumber(),
            },
          ],
        };
      }

      const reason = (
        {
          receive: 'RECEIVED',
          use: 'USED',
          damaged: 'DAMAGED',
          count: 'COUNTED',
          correct: 'CORRECTED',
        } as const
      )[input.action];

      await tx.stockMovement.create({
        data: {
          ...base,
          placeId: place.id,
          quantity: delta,
          reason,
          countedQuantity: input.action === 'count' ? decimal(input.counted) : null,
        },
      });

      return { onHand: [{ placeId: place.id, onHand: after.toNumber() }] };
    });
  }

  // -------------------------------------------------------------------------
  // Materials used on a job
  // -------------------------------------------------------------------------

  async jobMaterials(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
  ): Promise<JobMaterialsResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const access = await loadJobAccess(tx, permissions, membershipId, jobId);
      const defaultPlace = await this.defaultPlaceFor(tx, access);
      const rows = await tx.stockMovement.findMany({
        where: { jobId, reason: 'USED' },
        include: {
          item: { select: { name: true, unit: true } },
          place: { select: placeSelect },
          voidedBy: { select: { note: true, recordedByName: true, createdAt: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      return {
        materials: rows.map((row): JobMaterial => ({
          id: row.id,
          itemId: row.itemId,
          itemName: row.item.name,
          unit: row.item.unit,
          placeId: row.placeId,
          placeName: placeName(row.place),
          quantity: row.quantity.negated().toNumber(),
          note: row.note,
          recordedByName: row.recordedByName,
          createdAt: row.createdAt.toISOString(),
          packFields: asObject(row.packFields),
          voided: row.voidedBy
            ? {
                reason: row.voidedBy.note ?? '',
                byName: row.voidedBy.recordedByName,
                at: row.voidedBy.createdAt.toISOString(),
              }
            : null,
        })),
        defaultPlaceId: defaultPlace?.id ?? null,
        canRecord: access.canRecordWork,
      };
    });
  }

  /**
   * Record stock used on a job: a "used" row linked to the job, taken from the
   * job's vehicle, else its branch, unless another place is chosen.
   *
   * Every enabled pack that adds fields to a treatment line must be given
   * them; for Pest Control that makes the line an application record. The
   * crew on the job may record it whatever their role: authority from the
   * row, like completing the job. Recording on a series visit marks it as
   * touched, so a later rule change never removes a visit with records on it.
   */
  async recordJobMaterial(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    enabledModules: ReadonlySet<string>,
    jobId: string,
    input: RecordJobMaterialRequest,
  ): Promise<JobMaterialsResponse> {
    await this.prisma.withTenant(context, async (tx) => {
      const access = await loadJobAccess(tx, permissions, membershipId, jobId);
      if (!access.canRecordWork) {
        throw new ForbiddenException('Only the crew on this job, or a manager, can record that');
      }

      const item = await tx.inventoryItem.findUnique({ where: { id: input.itemId } });
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);
      if (item.archivedAt) throw new BadRequestException('That item is archived');

      const defaultPlace = await this.defaultPlaceFor(tx, access);
      let place: PlaceRow;
      if (input.placeId && input.placeId !== defaultPlace?.id) {
        place = await this.loadPlace(tx, permissions, membershipId, input.placeId);
        this.assertAuthority(permissions, membershipId, place, true);
      } else if (defaultPlace) {
        place = defaultPlace;
      } else {
        throw new BadRequestException(
          'This job has no branch or vehicle to take stock from. Choose where it came from.',
        );
      }

      const checked = checkPackFields('jobUse', input.packFields, {}, enabledModules, 'require');
      const packFields: Record<string, unknown> = { ...checked };
      if (MODULES.PEST_CONTROL in checked) {
        packFields[MODULES.PEST_CONTROL] = await enrichPestTreatment(
          tx,
          checked[MODULES.PEST_CONTROL] as PestTreatmentFields,
          item,
          membershipId,
        );
      }

      await this.lock(tx, item.id, [place.id]);
      const onHand = await this.onHandAt(tx, item.id, place.id);
      const delta = decimal(input.quantity).negated();
      const after = onHand.plus(delta);
      if (after.isNegative() && !input.acknowledgeNegative) {
        throw new ConflictException({
          statusCode: 409,
          code: 'STOCK_BELOW_ZERO',
          message: `${placeName(place)} has ${onHand.toNumber()} ${item.unit} of ${item.name}. This would leave ${after.toNumber()}.`,
          onHand: onHand.toNumber(),
          after: after.toNumber(),
        });
      }

      await tx.stockMovement.create({
        data: {
          organizationId: context.organizationId,
          itemId: item.id,
          placeId: place.id,
          quantity: delta,
          reason: 'USED',
          jobId,
          note: input.note?.trim() || null,
          packFields: packFields as Prisma.InputJsonValue,
          recordedById: membershipId,
          recordedByName: await this.nameOf(tx, membershipId),
        },
      });

      if (access.job.seriesId && !access.job.detachedFromSeries) {
        await tx.job.update({ where: { id: jobId }, data: { detachedFromSeries: true } });
      }
    });

    return this.jobMaterials(context, permissions, membershipId, jobId);
  }

  /**
   * Void a line entered by mistake. The line stays, and a correcting row puts
   * the stock back and says why: records are never edited or deleted.
   */
  async voidJobMaterial(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    movementId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const line = await tx.stockMovement.findFirst({
        where: { id: movementId, reason: 'USED', jobId: { not: null } },
        include: { voidedBy: { select: { id: true } } },
      });
      if (!line?.jobId) throw new NotFoundException('That line does not exist');

      const access = await loadJobAccess(tx, permissions, membershipId, line.jobId);
      if (!access.canRecordWork) {
        throw new ForbiddenException('Only the crew on this job, or a manager, can void that');
      }

      await this.lock(tx, line.itemId, [line.placeId]);
      const again = await tx.stockMovement.findFirst({
        where: { voidsMovementId: movementId },
        select: { id: true },
      });
      if (line.voidedBy || again) throw new ConflictException('That line is already voided');

      await tx.stockMovement.create({
        data: {
          organizationId: context.organizationId,
          itemId: line.itemId,
          placeId: line.placeId,
          quantity: line.quantity.negated(),
          reason: 'CORRECTED',
          jobId: line.jobId,
          voidsMovementId: movementId,
          note: reason,
          recordedById: membershipId,
          recordedByName: await this.nameOf(tx, membershipId),
        },
      });
    });
  }

  /** The job's vehicle, else its branch. */
  private async defaultPlaceFor(
    tx: TransactionClient,
    access: JobAccess,
  ): Promise<PlaceRow | null> {
    if (access.job.vehicleId) {
      const van = await tx.stockPlace.findFirst({
        where: { fleetAssetId: access.job.vehicleId },
        select: placeSelect,
      });
      if (van) return van;
    }
    if (access.job.locationId) {
      return tx.stockPlace.findFirst({
        where: { locationId: access.job.locationId, kind: 'BRANCH' },
        select: placeSelect,
      });
    }
    return null;
  }

  /** Serialise changes to one item at these places. */
  private async lock(tx: TransactionClient, itemId: string, placeIds: string[]): Promise<void> {
    for (const id of [...placeIds].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${itemId}:${id}`}, 0))`;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Places at branches the reader can see, and the van they usually drive. */
  private visibilityFilter(
    permissions: PermissionSet,
    membershipId: string,
  ): Prisma.StockPlaceWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.INVENTORY_READ);
    if (allowed === null) return {};
    return {
      OR: [
        { locationId: { in: [...allowed] } },
        { fleetAsset: { assignedMembershipId: membershipId } },
      ],
    };
  }

  private async visiblePlaces(
    tx: TransactionClient,
    permissions: PermissionSet,
    membershipId: string,
  ): Promise<PlaceRow[]> {
    return tx.stockPlace.findMany({
      where: this.visibilityFilter(permissions, membershipId),
      select: placeSelect,
      orderBy: [{ location: { name: 'asc' } }],
    });
  }

  /** A place the reader can see, or 404 — the same answer as one that does not exist. */
  private async loadPlace(
    tx: TransactionClient,
    permissions: PermissionSet,
    membershipId: string,
    placeId: string,
  ): Promise<PlaceRow> {
    const place = await tx.stockPlace.findFirst({
      where: { AND: [{ id: placeId }, this.visibilityFilter(permissions, membershipId)] },
      select: placeSelect,
    });
    if (!place) throw new NotFoundException(PLACE_NOT_FOUND);
    return place;
  }

  private canManage(permissions: PermissionSet, place: { locationId: string }): boolean {
    return permissions.hasAt(PERMISSIONS.INVENTORY_WRITE, place.locationId);
  }

  private canTake(permissions: PermissionSet, membershipId: string, place: PlaceRow): boolean {
    return (
      this.canManage(permissions, place) ||
      // Authority from the row: the van's usual driver, like a task's assignee.
      (place.fleetAsset !== null && place.fleetAsset.assignedMembershipId === membershipId) ||
      (place.employeesCanTake && permissions.hasAt(PERMISSIONS.INVENTORY_READ, place.locationId))
    );
  }

  private assertAuthority(
    permissions: PermissionSet,
    membershipId: string,
    place: PlaceRow,
    taking: boolean,
  ): void {
    if (
      taking ? this.canTake(permissions, membershipId, place) : this.canManage(permissions, place)
    ) {
      return;
    }

    throw new ForbiddenException(
      taking
        ? `${placeName(place)} does not let employees take stock. Ask a manager.`
        : `Only a manager of ${place.location.name} can do that`,
    );
  }

  /** item id -> place id -> on hand, summed over the given places. */
  private async totals(
    tx: TransactionClient,
    placeIds: string[],
    itemId: string | null,
  ): Promise<Map<string, Map<string, Decimal>>> {
    const sums = await tx.stockMovement.groupBy({
      by: ['itemId', 'placeId'],
      where: { placeId: { in: placeIds }, ...(itemId ? { itemId } : {}) },
      _sum: { quantity: true },
    });

    const totals = new Map<string, Map<string, Decimal>>();
    for (const row of sums) {
      const byPlace = totals.get(row.itemId) ?? new Map<string, Decimal>();
      byPlace.set(row.placeId, row._sum.quantity ?? ZERO);
      totals.set(row.itemId, byPlace);
    }
    return totals;
  }

  private async onHandAt(tx: TransactionClient, itemId: string, placeId: string): Promise<Decimal> {
    const sum = await tx.stockMovement.aggregate({
      where: { itemId, placeId },
      _sum: { quantity: true },
    });
    return sum._sum.quantity ?? ZERO;
  }

  private async nameOf(tx: TransactionClient, membershipId: string): Promise<string> {
    const membership = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    const user = membership?.user;
    if (!user) return 'Someone';
    return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  }

  private async assertUnique(
    tx: TransactionClient,
    name: string | null,
    sku: string | null,
    exceptId: string | null,
  ): Promise<void> {
    const notThis = exceptId ? { NOT: { id: exceptId } } : {};

    if (name !== null) {
      const clash = await tx.inventoryItem.findFirst({
        where: {
          AND: [{ name: { equals: name, mode: 'insensitive' }, archivedAt: null }, notThis],
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`There is already an item called "${name}"`);
    }

    if (sku !== null) {
      const clash = await tx.inventoryItem.findFirst({
        where: { AND: [{ sku: { equals: sku, mode: 'insensitive' } }, notThis] },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`SKU ${sku} is already used by another item`);
    }
  }

  private toPlace(place: PlaceRow, permissions: PermissionSet, membershipId: string): StockPlace {
    return {
      id: place.id,
      kind: place.kind,
      name: placeName(place),
      locationId: place.locationId,
      assetId: place.fleetAsset?.id ?? null,
      inactive: place.location.status === 'INACTIVE' || place.fleetAsset?.status === 'RETIRED',
      employeesCanTake: place.employeesCanTake,
      canManage: this.canManage(permissions, place),
      canTake: this.canTake(permissions, membershipId, place),
    };
  }

  private toItem(item: ItemRow, byPlace: Map<string, Decimal> | undefined): InventoryItem {
    const level = item.lowStockLevel;
    const places = [...(byPlace ?? new Map<string, Decimal>())].map(([placeId, onHand]) => ({
      placeId,
      onHand: onHand.toNumber(),
      // Only places that carry the item appear here at all, so a branch that
      // never stocks it is not forever "low".
      low: level !== null && onHand.lessThanOrEqualTo(level),
    }));
    const onHand = [...(byPlace?.values() ?? [])].reduce((sum, value) => sum.plus(value), ZERO);

    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      category: item.category,
      costCents: item.costCents,
      lowStockLevel: level?.toNumber() ?? null,
      archived: item.archivedAt !== null,
      onHand: onHand.toNumber(),
      places,
      low: item.archivedAt === null && places.some((place) => place.low),
      packFields: asObject(item.packFields),
    };
  }
}
