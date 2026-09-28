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
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import type { PermissionSet } from '../rbac/permission-set';
import { PrismaService } from '../prisma/prisma.service';

const ITEM_NOT_FOUND = 'Item not found';
const PLACE_NOT_FOUND = 'That place does not exist';
const HISTORY_LIMIT = 200;

type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);
const decimal = (value: number) => new Prisma.Decimal(value.toString());

type PlaceRow = {
  id: string;
  kind: 'BRANCH';
  locationId: string;
  employeesCanTake: boolean;
  location: { name: string; status: 'ACTIVE' | 'INACTIVE' };
};

type ItemRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  costCents: number | null;
  lowStockLevel: Decimal | null;
  archivedAt: Date | null;
};

const placeSelect = {
  id: true,
  kind: true,
  locationId: true,
  employeesCanTake: true,
  location: { select: { name: true, status: true } },
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
 * and nowhere else, so it can never reach beyond inventory.
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
    includeArchived: boolean,
  ): Promise<InventoryResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const places = await this.visiblePlaces(tx, permissions);
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
        places: places.map((place) => this.toPlace(place, permissions)),
      };
    });
  }

  async item(
    context: TenantContext,
    permissions: PermissionSet,
    itemId: string,
  ): Promise<ItemDetailResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);

      const places = await this.visiblePlaces(tx, permissions);
      const placeIds = places.map((place) => place.id);
      const totals = await this.totals(tx, placeIds, itemId);
      const names = new Map(places.map((place) => [place.id, place.location.name]));

      const movements = await tx.stockMovement.findMany({
        where: { itemId, placeId: { in: placeIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: HISTORY_LIMIT,
      });

      return {
        item: this.toItem(item, totals.get(item.id)),
        places: places.map((place) => this.toPlace(place, permissions)),
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

  /** How many items are low at places the reader can see. For the dashboard. */
  async lowStockCount(context: TenantContext, permissions: PermissionSet): Promise<number> {
    const { items } = await this.overview(context, permissions, false);
    return items.filter((item) => item.low).length;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async createItem(context: TenantContext, input: CreateItemRequest): Promise<InventoryItem> {
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
        },
      });
    });

    return this.toItem(item, undefined);
  }

  async updateItem(
    context: TenantContext,
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
    placeId: string,
    input: UpdatePlaceRequest,
  ): Promise<StockPlace> {
    return this.prisma.withTenant(context, async (tx) => {
      const place = await this.loadPlace(tx, permissions, placeId);

      if (!permissions.hasAt(PERMISSIONS.INVENTORY_WRITE, place.locationId)) {
        throw new ForbiddenException('Only a manager of this branch can change that');
      }

      const updated = await tx.stockPlace.update({
        where: { id: placeId },
        data: { employeesCanTake: input.employeesCanTake },
        select: placeSelect,
      });

      return this.toPlace(updated, permissions);
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

      const place = await this.loadPlace(tx, permissions, input.placeId);
      const toPlace =
        input.action === 'move' ? await this.loadPlace(tx, permissions, input.toPlaceId) : null;
      if (toPlace && toPlace.id === place.id) {
        throw new BadRequestException('Choose a different place to move it to');
      }

      const taking = input.action === 'use' || input.action === 'move';
      for (const target of toPlace ? [place, toPlace] : [place]) {
        this.assertAuthority(permissions, target, taking);
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
          message: `${place.location.name} has ${onHand.toNumber()} ${item.unit} of ${item.name}. This would leave ${after.toNumber()}.`,
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
  // Helpers
  // -------------------------------------------------------------------------

  private visibilityFilter(permissions: PermissionSet): Prisma.StockPlaceWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.INVENTORY_READ);
    return allowed === null ? {} : { locationId: { in: [...allowed] } };
  }

  private async visiblePlaces(
    tx: TransactionClient,
    permissions: PermissionSet,
  ): Promise<PlaceRow[]> {
    return tx.stockPlace.findMany({
      where: this.visibilityFilter(permissions),
      select: placeSelect,
      orderBy: [{ location: { name: 'asc' } }],
    });
  }

  /** A place the reader can see, or 404 — the same answer as one that does not exist. */
  private async loadPlace(
    tx: TransactionClient,
    permissions: PermissionSet,
    placeId: string,
  ): Promise<PlaceRow> {
    const place = await tx.stockPlace.findFirst({
      where: { AND: [{ id: placeId }, this.visibilityFilter(permissions)] },
      select: placeSelect,
    });
    if (!place) throw new NotFoundException(PLACE_NOT_FOUND);
    return place;
  }

  private canManage(permissions: PermissionSet, place: { locationId: string }): boolean {
    return permissions.hasAt(PERMISSIONS.INVENTORY_WRITE, place.locationId);
  }

  private canTake(
    permissions: PermissionSet,
    place: { locationId: string; employeesCanTake: boolean },
  ): boolean {
    return (
      this.canManage(permissions, place) ||
      (place.employeesCanTake && permissions.hasAt(PERMISSIONS.INVENTORY_READ, place.locationId))
    );
  }

  private assertAuthority(permissions: PermissionSet, place: PlaceRow, taking: boolean): void {
    if (taking ? this.canTake(permissions, place) : this.canManage(permissions, place)) return;

    throw new ForbiddenException(
      taking
        ? `${place.location.name} does not let employees take stock. Ask a manager.`
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

  private toPlace(place: PlaceRow, permissions: PermissionSet): StockPlace {
    return {
      id: place.id,
      kind: place.kind,
      name: place.location.name,
      locationId: place.locationId,
      inactive: place.location.status === 'INACTIVE',
      employeesCanTake: place.employeesCanTake,
      canManage: this.canManage(permissions, place),
      canTake: this.canTake(permissions, place),
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
    };
  }
}
