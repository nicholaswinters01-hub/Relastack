import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Inventory.
 *
 * The parts that carry the design:
 *
 *   - on hand is the sum of a ledger nobody can edit
 *   - taking stock below zero warns and can be recorded anyway
 *   - a manager's numbers are their branches' numbers, never the company's
 *   - each branch decides whether its employees may take stock, and that
 *     setting reaches nothing beyond that branch's stock
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

describe('Inventory (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let privileged: PrismaClient;

  let organizationId: string;
  let adminUserId: string;
  let admin: Actor;
  let manager: Actor;
  let tech: Actor;
  let northTech: Actor;

  let downtownPlace: string;
  let northsidePlace: string;

  let otherToken: string;
  let otherItemId: string;
  let otherPlaceId: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (response: InjectResult) => JSON.parse(response.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  const change = (token: string, body: Record<string, unknown>) =>
    request('POST', '/api/v1/inventory/changes', token, body);

  let itemCounter = 0;
  async function newItem(name = `Item ${++itemCounter}`): Promise<string> {
    const response = await request('POST', '/api/v1/inventory/items', admin.token, {
      name,
      unit: 'gal',
      lowStockLevel: 2,
    });
    expect(response.statusCode, response.body).toBe(201);
    return json(response).id;
  }

  async function onHand(token: string, itemId: string): Promise<Record<string, number>> {
    const response = await request('GET', `/api/v1/inventory/items/${itemId}`, token);
    expect(response.statusCode, response.body).toBe(200);
    return Object.fromEntries(
      json(response).item.places.map((p: { placeId: string; onHand: number }) => [
        p.placeId,
        p.onHand,
      ]),
    );
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-inv-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Inv Test%'");
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const email = `e2e-inv-${slug}@example.test`;
    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `Inv Test Throwaway ${slug}`,
    });
    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Inv Test Throwaway ${slug}` } });

    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });
    const assignment = await privileged.membershipRole.create({
      data: { membershipId: membership.id, roleId, scope: 'LOCATION', organizationId },
    });
    for (const locationId of locationIds) {
      await privileged.membershipRoleLocation.create({
        data: { membershipRoleId: assignment.id, locationId, organizationId },
      });
    }

    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email,
      password: PASSWORD,
    });
    return { token: tokenOf(login), membershipId: membership.id };
  }

  const placeFor = async (locationId: string) =>
    (await privileged.stockPlace.findFirstOrThrow({ where: { locationId } })).id;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-inv-admin@example.test',
      password: PASSWORD,
      organizationName: 'Inv Test Company',
    });
    adminUserId = json(registration).user.id;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: adminUserId },
    });
    organizationId = membership.organizationId;
    admin = { token: tokenOf(registration), membershipId: membership.id };

    const enabled = await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, admin.token);
    expect(enabled.statusCode, enabled.body).toBe(200);

    const downtown = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Downtown',
        timezone: 'America/New_York',
      }),
    ).location.id;
    const northside = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Northside',
        timezone: 'America/New_York',
      }),
    ).location.id;
    downtownPlace = await placeFor(downtown);
    northsidePlace = await placeFor(northside);

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, [downtown]);
    tech = await addPerson('tech', SYSTEM_ROLE_IDS.employee, [downtown]);
    northTech = await addPerson('northtech', SYSTEM_ROLE_IDS.employee, [northside]);

    const other = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-inv-other@example.test',
      password: PASSWORD,
      organizationName: 'Inv Test Competitor',
    });
    otherToken = tokenOf(other);
    await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, otherToken);
    const otherLocation = json(
      await request('POST', '/api/v1/locations', otherToken, {
        name: 'Rival Yard',
        timezone: 'America/New_York',
      }),
    ).location.id;
    otherPlaceId = await placeFor(otherLocation);
    otherItemId = json(
      await request('POST', '/api/v1/inventory/items', otherToken, {
        name: 'Rival Secret Blend',
        unit: 'gal',
      }),
    ).id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('module gating', () => {
    it('refuses inventory when the module is off', async () => {
      const off = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-inv-nomodule@example.test',
        password: PASSWORD,
        organizationName: 'Inv Test No Module',
      });

      const response = await request('GET', '/api/v1/inventory', tokenOf(off));

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
    });
  });

  // =========================================================================

  describe('places', () => {
    it('makes every branch a stock place, including ones opened later', async () => {
      const opened = json(
        await request('POST', '/api/v1/locations', admin.token, {
          name: 'Eastgate',
          timezone: 'America/New_York',
        }),
      ).location.id;

      const places = json(await request('GET', '/api/v1/inventory', admin.token)).places;
      expect(places.map((p: { name: string }) => p.name)).toEqual(
        expect.arrayContaining(['Downtown', 'Northside', 'Eastgate']),
      );
      expect(places.find((p: { locationId: string }) => p.locationId === opened).kind).toBe(
        'BRANCH',
      );
    });
  });

  // =========================================================================

  describe('items', () => {
    it('lets an admin add items and refuses a manager', async () => {
      expect(
        (
          await request('POST', '/api/v1/inventory/items', manager.token, {
            name: 'Manager Item',
            unit: 'each',
          })
        ).statusCode,
      ).toBe(403);
      await newItem('Termite foam');
    });

    it('refuses a second live item with the same name, whatever the capitals', async () => {
      await newItem('Bait gel');
      const clash = await request('POST', '/api/v1/inventory/items', admin.token, {
        name: 'BAIT GEL',
        unit: 'each',
      });

      expect(clash.statusCode).toBe(409);
    });

    it('frees the name when the item is archived, and keeps it off the list', async () => {
      const id = await newItem('Old sprayer tips');
      const archived = await request('PATCH', `/api/v1/inventory/items/${id}`, admin.token, {
        archived: true,
      });
      expect(archived.statusCode, archived.body).toBe(204);

      const names = json(await request('GET', '/api/v1/inventory', admin.token)).items.map(
        (i: { name: string }) => i.name,
      );
      expect(names).not.toContain('Old sprayer tips');
      await newItem('Old sprayer tips');
    });

    it('refuses stock changes for an archived item', async () => {
      const id = await newItem();
      await request('PATCH', `/api/v1/inventory/items/${id}`, admin.token, { archived: true });

      const response = await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 1,
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('the ledger', () => {
    it('keeps on hand as the sum of every change', async () => {
      const id = await newItem();

      expect(
        (
          await change(admin.token, {
            action: 'receive',
            itemId: id,
            placeId: downtownPlace,
            quantity: 10,
          })
        ).statusCode,
      ).toBe(201);
      await change(admin.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 2.5,
      });
      expect((await onHand(admin.token, id))[downtownPlace]).toBe(7.5);

      // A count records the difference, so drift shows as its own line.
      await change(admin.token, {
        action: 'count',
        itemId: id,
        placeId: downtownPlace,
        counted: 6,
      });
      await change(admin.token, {
        action: 'move',
        itemId: id,
        placeId: downtownPlace,
        toPlaceId: northsidePlace,
        quantity: 2,
      });

      const levels = await onHand(admin.token, id);
      expect(levels[downtownPlace]).toBe(4);
      expect(levels[northsidePlace]).toBe(2);

      const detail = json(await request('GET', `/api/v1/inventory/items/${id}`, admin.token));
      const reasons = detail.movements.map((m: { reason: string }) => m.reason);
      expect(reasons).toEqual(
        expect.arrayContaining(['RECEIVED', 'USED', 'COUNTED', 'MOVED_OUT', 'MOVED_IN']),
      );
      const count = detail.movements.find((m: { reason: string }) => m.reason === 'COUNTED');
      expect(count).toMatchObject({ quantity: -1.5, countedQuantity: 6 });
      expect(detail.item.onHand).toBe(6);
    });

    it('warns before stock goes below zero, and records it when told to', async () => {
      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 1,
      });

      const warned = await change(admin.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 3,
      });
      expect(warned.statusCode).toBe(409);
      expect(json(warned)).toMatchObject({ code: 'STOCK_BELOW_ZERO', onHand: 1, after: -2 });
      expect((await onHand(admin.token, id))[downtownPlace]).toBe(1);

      const recorded = await change(admin.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 3,
        acknowledgeNegative: true,
      });
      expect(recorded.statusCode, recorded.body).toBe(201);
      expect((await onHand(admin.token, id))[downtownPlace]).toBe(-2);
    });

    it('asks every correction to say why', async () => {
      const id = await newItem();
      const response = await change(admin.token, {
        action: 'correct',
        itemId: id,
        placeId: downtownPlace,
        change: 4,
      });
      expect(response.statusCode).toBe(400);
    });

    it('cannot be edited or deleted by the application, only added to', async () => {
      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 5,
      });
      const context = { organizationId, userId: adminUserId };

      await expect(
        prisma.withTenant(context, (tx) =>
          tx.stockMovement.updateMany({ where: { itemId: id }, data: { quantity: 500 } }),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withTenant(context, (tx) => tx.stockMovement.deleteMany({ where: { itemId: id } })),
      ).rejects.toThrow(/permission denied/i);
      expect((await onHand(admin.token, id))[downtownPlace]).toBe(5);
    });

    it('refuses a received row that takes stock away, at the database', async () => {
      const id = await newItem();
      await expect(
        prisma.withTenant({ organizationId, userId: adminUserId }, (tx) =>
          tx.stockMovement.create({
            data: {
              organizationId,
              itemId: id,
              placeId: downtownPlace,
              quantity: -5,
              reason: 'RECEIVED',
              recordedByName: 'Nobody',
            },
          }),
        ),
      ).rejects.toThrow(/stock_movements_sign/);
    });
  });

  // =========================================================================

  describe('branch scope', () => {
    it('shows a manager only their branch, in lists and in totals', async () => {
      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 3,
      });
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: northsidePlace,
        quantity: 40,
      });

      const overview = json(await request('GET', '/api/v1/inventory', manager.token));
      expect(overview.places.map((p: { name: string }) => p.name)).toEqual(['Downtown']);
      const item = overview.items.find((i: { id: string }) => i.id === id);
      // The company holds 43; the manager is told about their 3 and no more.
      expect(item.onHand).toBe(3);

      const detail = json(await request('GET', `/api/v1/inventory/items/${id}`, manager.token));
      expect(detail.movements.every((m: { placeId: string }) => m.placeId === downtownPlace)).toBe(
        true,
      );
    });

    it('treats another branch as not there at all', async () => {
      const id = await newItem();
      const response = await change(manager.token, {
        action: 'receive',
        itemId: id,
        placeId: northsidePlace,
        quantity: 1,
      });
      expect(response.statusCode).toBe(404);
    });

    it('lets the manager receive and count at their own branch', async () => {
      const id = await newItem();
      expect(
        (
          await change(manager.token, {
            action: 'receive',
            itemId: id,
            placeId: downtownPlace,
            quantity: 4,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await change(manager.token, {
            action: 'count',
            itemId: id,
            placeId: downtownPlace,
            counted: 4,
          })
        ).statusCode,
      ).toBe(201);
    });
  });

  // =========================================================================

  describe('employees taking stock', () => {
    it('lets employees read but not take, until their branch allows it', async () => {
      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 5,
      });

      expect((await request('GET', '/api/v1/inventory', tech.token)).statusCode).toBe(200);
      const refused = await change(tech.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 1,
      });
      expect(refused.statusCode).toBe(403);
    });

    it('does not let an employee change the setting', async () => {
      const response = await request(
        'PATCH',
        `/api/v1/inventory/places/${downtownPlace}`,
        tech.token,
        { employeesCanTake: true },
      );
      expect(response.statusCode).toBe(403);
    });

    it('once allowed, lets them use stock there, and nothing more', async () => {
      const allowed = await request(
        'PATCH',
        `/api/v1/inventory/places/${downtownPlace}`,
        manager.token,
        { employeesCanTake: true },
      );
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(json(allowed).employeesCanTake).toBe(true);

      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 5,
      });

      const used = await change(tech.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 2,
      });
      expect(used.statusCode, used.body).toBe(201);
      expect(json(used).onHand[0].onHand).toBe(3);

      // Receiving and counting stay with managers.
      for (const body of [
        { action: 'receive', itemId: id, placeId: downtownPlace, quantity: 1 },
        { action: 'count', itemId: id, placeId: downtownPlace, counted: 99 },
        { action: 'damaged', itemId: id, placeId: downtownPlace, quantity: 1 },
      ]) {
        expect((await change(tech.token, body)).statusCode).toBe(403);
      }

      // Moving to a branch they cannot see is refused as if it did not exist.
      const moved = await change(tech.token, {
        action: 'move',
        itemId: id,
        placeId: downtownPlace,
        toPlaceId: northsidePlace,
        quantity: 1,
      });
      expect(moved.statusCode).toBe(404);

      const detail = json(await request('GET', `/api/v1/inventory/items/${id}`, admin.token));
      expect(detail.movements.find((m: { reason: string }) => m.reason === 'USED')).toMatchObject({
        quantity: -2,
      });
    });

    it('gives an employee at another branch nothing from Downtown’s setting', async () => {
      const id = await newItem();
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: downtownPlace,
        quantity: 5,
      });

      const response = await change(northTech.token, {
        action: 'use',
        itemId: id,
        placeId: downtownPlace,
        quantity: 1,
      });
      expect(response.statusCode).toBe(404);

      // And their own branch still does not allow it.
      await change(admin.token, {
        action: 'receive',
        itemId: id,
        placeId: northsidePlace,
        quantity: 5,
      });
      const own = await change(northTech.token, {
        action: 'use',
        itemId: id,
        placeId: northsidePlace,
        quantity: 1,
      });
      expect(own.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never lists another business’s items', async () => {
      const names = json(await request('GET', '/api/v1/inventory', admin.token)).items.map(
        (i: { name: string }) => i.name,
      );
      expect(names).not.toContain('Rival Secret Blend');
    });

    it('answers 404 for another business’s item, place and setting', async () => {
      expect(
        (await request('GET', `/api/v1/inventory/items/${otherItemId}`, admin.token)).statusCode,
      ).toBe(404);
      expect(
        (
          await request('PATCH', `/api/v1/inventory/items/${otherItemId}`, admin.token, {
            name: 'Mine',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await change(admin.token, {
            action: 'receive',
            itemId: otherItemId,
            placeId: downtownPlace,
            quantity: 1,
          })
        ).statusCode,
      ).toBe(404);

      const id = await newItem();
      expect(
        (
          await change(admin.token, {
            action: 'receive',
            itemId: id,
            placeId: otherPlaceId,
            quantity: 1,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request('PATCH', `/api/v1/inventory/places/${otherPlaceId}`, admin.token, {
            employeesCanTake: true,
          })
        ).statusCode,
      ).toBe(404);
    });

    it('refuses, at the database, a movement joining two businesses', async () => {
      const id = await newItem();
      await expect(
        prisma.withTenant({ organizationId, userId: adminUserId }, (tx) =>
          tx.stockMovement.create({
            data: {
              organizationId,
              itemId: id,
              placeId: otherPlaceId,
              quantity: 1,
              reason: 'RECEIVED',
              recordedByName: 'Nobody',
            },
          }),
        ),
      ).rejects.toThrow(/not one organization/);
    });
  });
});
