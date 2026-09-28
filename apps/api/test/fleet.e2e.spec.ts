import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Fleet, and the pack that brings it.
 *
 * The parts that carry the design:
 *
 *   - Fleet is never chosen alone: a business has it only through a pack
 *   - authority over a vehicle follows its home branch, and its usual driver
 *     may log readings and take stock from it whatever their role
 *   - a vehicle is a stock place, and moves branch with the vehicle
 *   - a vehicle booked on overlapping jobs warns and can be overridden
 */

const PASSWORD = 'a-sufficiently-long-password';
const DAY = '2026-09-07';
const at = (time: string) => `${DAY}T${time}:00.000Z`;

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

describe('Fleet (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let privileged: PrismaClient;

  let organizationId: string;
  let adminUserId: string;
  let admin: Actor;
  let manager: Actor;
  let driver: Actor;
  let tech: Actor;
  let northTech: Actor;

  let downtownId: string;
  let northsideId: string;

  let otherToken: string;
  let otherAssetId: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

  let assetCounter = 0;
  async function newVan(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await request('POST', '/api/v1/fleet/assets', admin.token, {
      name: `Van ${++assetCounter}`,
      kind: 'VEHICLE',
      locationId: downtownId,
      meter: 'MILES',
      initialReading: 1000,
      ...overrides,
    });
    expect(response.statusCode, response.body).toBe(201);
    return json(response).id;
  }

  const asset = async (token: string, id: string) =>
    json(await request('GET', `/api/v1/fleet/assets/${id}`, token));

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-fleet-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Fleet Test%'");
  }

  async function register(slug: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-fleet-${slug}@example.test`,
      password: PASSWORD,
      organizationName,
    });
    return { token: tokenOf(response), userId: json(response).user.id as string };
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const { userId } = await register(slug, `Fleet Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Fleet Test Throwaway ${slug}` } });

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
      email: `e2e-fleet-${slug}@example.test`,
      password: PASSWORD,
    });
    return { token: tokenOf(login), membershipId: membership.id };
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const owner = await register('admin', 'Fleet Test Company');
    adminUserId = owner.userId;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: adminUserId },
    });
    organizationId = membership.organizationId;
    admin = { token: owner.token, membershipId: membership.id };

    // The trial includes the pack; turning the pack on turns on what it needs.
    const enabled = await request('POST', `/api/v1/modules/${MODULES.PEST_CONTROL}`, admin.token);
    expect(enabled.statusCode, enabled.body).toBe(200);

    downtownId = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Downtown',
        timezone: 'America/New_York',
      }),
    ).location.id;
    northsideId = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Northside',
        timezone: 'America/New_York',
      }),
    ).location.id;

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, [downtownId]);
    driver = await addPerson('driver', SYSTEM_ROLE_IDS.employee, [downtownId]);
    tech = await addPerson('tech', SYSTEM_ROLE_IDS.employee, [downtownId]);
    northTech = await addPerson('northtech', SYSTEM_ROLE_IDS.employee, [northsideId]);

    const other = await register('other', 'Fleet Test Competitor');
    otherToken = other.token;
    await request('POST', `/api/v1/modules/${MODULES.FLEET}`, otherToken);
    const otherLocation = json(
      await request('POST', '/api/v1/locations', otherToken, {
        name: 'Rival Yard',
        timezone: 'America/New_York',
      }),
    ).location.id;
    otherAssetId = json(
      await request('POST', '/api/v1/fleet/assets', otherToken, {
        name: 'Rival Truck',
        kind: 'VEHICLE',
        locationId: otherLocation,
        meter: 'MILES',
      }),
    ).id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('entitlement', () => {
    it('turns on everything the pack needs', async () => {
      const modules = json(await request('GET', '/api/v1/modules', admin.token)).modules;
      const on = modules
        .filter((m: { enabled: boolean }) => m.enabled)
        .map((m: { key: string }) => m.key);
      expect(on).toEqual(
        expect.arrayContaining([MODULES.FLEET, MODULES.INVENTORY, MODULES.SCHEDULING]),
      );
    });

    it('refuses Fleet to a paying business without the pack, and gives it with the pack', async () => {
      const business = await register('payer', 'Fleet Test Payer');
      const payer = await privileged.organizationMembership.findFirstOrThrow({
        where: { userId: business.userId },
      });
      await privileged.subscription.update({
        where: { organizationId: payer.organizationId },
        data: { planKey: 'pro', status: 'ACTIVE', trialEndsAt: null },
      });

      // Not chosen alone, however it is asked for.
      expect(
        (await request('POST', `/api/v1/modules/${MODULES.FLEET}`, business.token)).statusCode,
      ).not.toBe(200);
      const refused = await request('GET', '/api/v1/fleet', business.token);
      expect(refused.statusCode).toBe(403);
      expect(json(refused).code).toBe('MODULE_NOT_ENABLED');

      // Staff switch the pack on, by hand.
      const staffUser = await register('staff', 'Fleet Test Staff Throwaway');
      await privileged.platformStaff.create({ data: { userId: staffUser.userId, note: 'e2e' } });
      const notAPack = await request(
        'POST',
        `/api/v1/staff/businesses/${payer.organizationId}/packs`,
        staffUser.token,
        { moduleKey: MODULES.FLEET, included: true, reason: 'Testing a module on its own' },
      );
      expect(notAPack.statusCode).toBe(400);

      const granted = await request(
        'POST',
        `/api/v1/staff/businesses/${payer.organizationId}/packs`,
        staffUser.token,
        { moduleKey: MODULES.PEST_CONTROL, included: true, priceCents: 3500, reason: 'Pilot' },
      );
      expect(granted.statusCode, granted.body).toBe(204);

      expect(
        (await request('POST', `/api/v1/modules/${MODULES.PEST_CONTROL}`, business.token))
          .statusCode,
      ).toBe(200);
      expect((await request('GET', '/api/v1/fleet', business.token)).statusCode).toBe(200);

      // Switching the pack off takes Fleet with it.
      const removed = await request(
        'POST',
        `/api/v1/staff/businesses/${payer.organizationId}/packs`,
        staffUser.token,
        { moduleKey: MODULES.PEST_CONTROL, included: false, reason: 'Pilot ended' },
      );
      expect(removed.statusCode, removed.body).toBe(204);
      expect((await request('GET', '/api/v1/fleet', business.token)).statusCode).toBe(403);

      const audit = await privileged.staffAuditEvent.findMany({
        where: { organizationId: payer.organizationId },
        select: { action: true },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['pack.added', 'pack.removed']),
      );
    });
  });

  // =========================================================================

  describe('assets', () => {
    it('lets a manager add a vehicle at their branch, and not elsewhere', async () => {
      const created = await request('POST', '/api/v1/fleet/assets', manager.token, {
        name: 'Manager Van',
        kind: 'VEHICLE',
        locationId: downtownId,
        meter: 'MILES',
      });
      expect(created.statusCode, created.body).toBe(201);

      const elsewhere = await request('POST', '/api/v1/fleet/assets', manager.token, {
        name: 'Stray Van',
        kind: 'VEHICLE',
        locationId: northsideId,
        meter: 'MILES',
      });
      expect(elsewhere.statusCode).toBe(404);

      const byEmployee = await request('POST', '/api/v1/fleet/assets', tech.token, {
        name: 'Tech Van',
        kind: 'VEHICLE',
        locationId: downtownId,
        meter: 'MILES',
      });
      expect(byEmployee.statusCode).toBe(403);
    });

    it('refuses a second vehicle with the same name, whatever the capitals', async () => {
      await newVan({ name: 'Big Blue' });
      const clash = await request('POST', '/api/v1/fleet/assets', admin.token, {
        name: 'BIG BLUE',
        kind: 'VEHICLE',
        locationId: downtownId,
        meter: 'MILES',
      });
      expect(clash.statusCode).toBe(409);
    });

    it('makes a vehicle a stock place, and equipment not', async () => {
      const van = await asset(admin.token, await newVan());
      expect(van.asset.stockPlaceId).not.toBeNull();

      const sprayer = json(
        await request('POST', '/api/v1/fleet/assets', admin.token, {
          name: 'Backpack sprayer 1',
          kind: 'EQUIPMENT',
          locationId: downtownId,
          meter: 'NONE',
        }),
      );
      expect(sprayer.stockPlaceId).toBeNull();

      const places = json(await request('GET', '/api/v1/inventory', admin.token)).places;
      expect(places.find((p: { id: string }) => p.id === van.asset.stockPlaceId)).toMatchObject({
        kind: 'VEHICLE',
        name: van.asset.name,
      });
    });

    it('moves a vehicle’s stock to its new home branch', async () => {
      const id = await newVan();
      expect((await request('GET', `/api/v1/fleet/assets/${id}`, manager.token)).statusCode).toBe(
        200,
      );

      // The Downtown manager cannot send it somewhere they do not manage.
      expect(
        (
          await request('PATCH', `/api/v1/fleet/assets/${id}`, manager.token, {
            locationId: northsideId,
          })
        ).statusCode,
      ).toBe(404);

      const moved = await request('PATCH', `/api/v1/fleet/assets/${id}`, admin.token, {
        locationId: northsideId,
      });
      expect(moved.statusCode, moved.body).toBe(204);

      expect((await request('GET', `/api/v1/fleet/assets/${id}`, manager.token)).statusCode).toBe(
        404,
      );
      const place = await privileged.stockPlace.findFirstOrThrow({ where: { fleetAssetId: id } });
      expect(place.locationId).toBe(northsideId);
    });
  });

  // =========================================================================

  describe('readings', () => {
    it('lets the usual driver log readings, and warns when one goes backwards', async () => {
      const id = await newVan({ assignedMembershipId: driver.membershipId });

      const logged = await request('POST', `/api/v1/fleet/assets/${id}/readings`, driver.token, {
        value: 1200,
      });
      expect(logged.statusCode, logged.body).toBe(201);

      const lower = await request('POST', `/api/v1/fleet/assets/${id}/readings`, driver.token, {
        value: 1100,
      });
      expect(lower.statusCode).toBe(409);
      expect(json(lower)).toMatchObject({ code: 'READING_LOWER', latest: 1200 });

      const anyway = await request('POST', `/api/v1/fleet/assets/${id}/readings`, driver.token, {
        value: 1100,
        acknowledgeLower: true,
      });
      expect(anyway.statusCode).toBe(201);
      expect((await asset(admin.token, id)).asset.reading).toBe(1100);
    });

    it('refuses readings from anyone else who does not manage it', async () => {
      const id = await newVan({ assignedMembershipId: driver.membershipId });

      expect(
        (await request('POST', `/api/v1/fleet/assets/${id}/readings`, tech.token, { value: 2000 }))
          .statusCode,
      ).toBe(403);
      // At another branch it is not there at all.
      expect(
        (
          await request('POST', `/api/v1/fleet/assets/${id}/readings`, northTech.token, {
            value: 2000,
          })
        ).statusCode,
      ).toBe(404);
    });

    it('lets a driver see their own vehicle wherever it is kept', async () => {
      const id = await newVan({ assignedMembershipId: northTech.membershipId });
      expect((await request('GET', `/api/v1/fleet/assets/${id}`, northTech.token)).statusCode).toBe(
        200,
      );
      expect(
        (
          await request('POST', `/api/v1/fleet/assets/${id}/readings`, northTech.token, {
            value: 1500,
          })
        ).statusCode,
      ).toBe(201);
    });

    it('cannot be edited or deleted by the application', async () => {
      const id = await newVan();
      const context = { organizationId, userId: adminUserId };
      await expect(
        prisma.withTenant(context, (tx) =>
          tx.fleetReading.updateMany({ where: { assetId: id }, data: { value: 1 } }),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withTenant(context, (tx) => tx.fleetReading.deleteMany({ where: { assetId: id } })),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // =========================================================================

  describe('service reminders', () => {
    it('counts an oil change from the latest reading and moves it on when done', async () => {
      const id = await newVan();
      const created = await request('POST', `/api/v1/fleet/assets/${id}/reminders`, admin.token, {
        title: 'Oil change',
        intervalReading: 5000,
      });
      expect(created.statusCode, created.body).toBe(201);

      let reminder = (await asset(admin.token, id)).asset.reminders[0];
      expect(reminder).toMatchObject({ nextDueReading: 6000, state: 'OK' });

      await request('POST', `/api/v1/fleet/assets/${id}/readings`, admin.token, { value: 5700 });
      expect((await asset(admin.token, id)).asset.reminders[0].state).toBe('DUE_SOON');

      await request('POST', `/api/v1/fleet/assets/${id}/readings`, admin.token, { value: 6100 });
      const overdue = await asset(admin.token, id);
      expect(overdue.asset.serviceState).toBe('OVERDUE');

      const done = await request('POST', `/api/v1/fleet/assets/${id}/services`, admin.token, {
        reminderId: overdue.asset.reminders[0].id,
        reading: 6150,
        costCents: 8999,
      });
      expect(done.statusCode, done.body).toBe(201);

      const after = await asset(admin.token, id);
      reminder = after.asset.reminders[0];
      // From when it was done, not when it was due.
      expect(reminder).toMatchObject({ nextDueReading: 11150, state: 'OK' });
      expect(after.asset.reading).toBe(6150);
      expect(after.services[0]).toMatchObject({ title: 'Oil change', costCents: 8999 });
    });

    it('finishes a one-off reminder when it is done', async () => {
      const id = await newVan();
      await request('POST', `/api/v1/fleet/assets/${id}/reminders`, admin.token, {
        title: 'Registration',
        nextDueOn: '2020-01-01',
      });
      const due = await asset(admin.token, id);
      expect(due.asset.reminders[0].state).toBe('OVERDUE');

      await request('POST', `/api/v1/fleet/assets/${id}/services`, admin.token, {
        reminderId: due.asset.reminders[0].id,
      });
      expect((await asset(admin.token, id)).asset.reminders).toHaveLength(0);
    });

    it('keeps reminders with the managers', async () => {
      const id = await newVan({ assignedMembershipId: driver.membershipId });
      const response = await request('POST', `/api/v1/fleet/assets/${id}/reminders`, driver.token, {
        title: 'Tyres',
        intervalMonths: 6,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('stock on a van', () => {
    it('lets the usual driver take stock from their van, but not from the branch', async () => {
      const vanId = await newVan({ assignedMembershipId: driver.membershipId });
      const vanPlace = (await asset(admin.token, vanId)).asset.stockPlaceId;
      const branchPlace = (
        await privileged.stockPlace.findFirstOrThrow({
          where: { locationId: downtownId, kind: 'BRANCH' },
        })
      ).id;

      const itemId = json(
        await request('POST', '/api/v1/inventory/items', admin.token, {
          name: `Bait ${vanId.slice(0, 6)}`,
          unit: 'each',
        }),
      ).id;
      for (const placeId of [vanPlace, branchPlace]) {
        await request('POST', '/api/v1/inventory/changes', admin.token, {
          action: 'receive',
          itemId,
          placeId,
          quantity: 10,
        });
      }

      const fromVan = await request('POST', '/api/v1/inventory/changes', driver.token, {
        action: 'use',
        itemId,
        placeId: vanPlace,
        quantity: 2,
      });
      expect(fromVan.statusCode, fromVan.body).toBe(201);

      const fromBranch = await request('POST', '/api/v1/inventory/changes', driver.token, {
        action: 'use',
        itemId,
        placeId: branchPlace,
        quantity: 2,
      });
      expect(fromBranch.statusCode).toBe(403);

      // Another employee at the same branch has no claim on the driver's van.
      const byTech = await request('POST', '/api/v1/inventory/changes', tech.token, {
        action: 'use',
        itemId,
        placeId: vanPlace,
        quantity: 1,
      });
      expect(byTech.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('a vehicle on a job', () => {
    const book = async (title: string, start: string, end: string) =>
      json(
        await request('POST', '/api/v1/jobs', admin.token, {
          title,
          startsAt: at(start),
          endsAt: at(end),
          locationId: downtownId,
        }),
      ).job.id as string;

    it('warns when the vehicle is already out, and books it when told to', async () => {
      const vanId = await newVan();
      const first = await book('Morning route', '09:00', '11:00');
      const second = await book('Overlapping route', '10:00', '12:00');
      const later = await book('Afternoon route', '11:00', '13:00');

      const set = await request('PUT', `/api/v1/fleet/jobs/${first}/vehicle`, admin.token, {
        vehicleId: vanId,
      });
      expect(set.statusCode, set.body).toBe(200);

      const clash = await request('PUT', `/api/v1/fleet/jobs/${second}/vehicle`, admin.token, {
        vehicleId: vanId,
      });
      expect(clash.statusCode).toBe(409);
      expect(json(clash).code).toBe('VEHICLE_CONFLICT');

      // Back-to-back is how a day is filled.
      expect(
        (
          await request('PUT', `/api/v1/fleet/jobs/${later}/vehicle`, admin.token, {
            vehicleId: vanId,
          })
        ).statusCode,
      ).toBe(200);

      const anyway = await request('PUT', `/api/v1/fleet/jobs/${second}/vehicle`, admin.token, {
        vehicleId: vanId,
        acknowledgeConflicts: true,
      });
      expect(anyway.statusCode).toBe(200);

      const job = json(await request('GET', `/api/v1/jobs/${second}`, admin.token)).job;
      expect(job).toMatchObject({ vehicleId: vanId });
      expect(job.vehicleName).toMatch(/^Van /);
    });

    it('refuses a retired vehicle, and one from another business', async () => {
      const vanId = await newVan();
      await request('PATCH', `/api/v1/fleet/assets/${vanId}`, admin.token, { status: 'RETIRED' });
      const job = await book('Retired check', '14:00', '15:00');

      expect(
        (
          await request('PUT', `/api/v1/fleet/jobs/${job}/vehicle`, admin.token, {
            vehicleId: vanId,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await request('PUT', `/api/v1/fleet/jobs/${job}/vehicle`, admin.token, {
            vehicleId: otherAssetId,
          })
        ).statusCode,
      ).toBe(404);
    });

    it('does not let a crew member without job.write change it', async () => {
      const vanId = await newVan();
      const job = await book('Crew check', '15:00', '16:00');
      const response = await request('PUT', `/api/v1/fleet/jobs/${job}/vehicle`, tech.token, {
        vehicleId: vanId,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never lists another business’s vehicles', async () => {
      const names = json(await request('GET', '/api/v1/fleet', admin.token)).assets.map(
        (a: { name: string }) => a.name,
      );
      expect(names).not.toContain('Rival Truck');
    });

    it('answers 404 for another business’s vehicle, however it is reached', async () => {
      expect(
        (await request('GET', `/api/v1/fleet/assets/${otherAssetId}`, admin.token)).statusCode,
      ).toBe(404);
      expect(
        (
          await request('POST', `/api/v1/fleet/assets/${otherAssetId}/readings`, admin.token, {
            value: 9,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request('PATCH', `/api/v1/fleet/assets/${otherAssetId}`, admin.token, {
            name: 'Mine',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('refuses, at the database, a job pointing at another business’s vehicle', async () => {
      const job = json(
        await request('POST', '/api/v1/jobs', admin.token, {
          title: 'Trigger check',
          startsAt: at('17:00'),
          endsAt: at('18:00'),
        }),
      ).job.id;
      await expect(
        prisma.withTenant({ organizationId, userId: adminUserId }, (tx) =>
          tx.job.update({ where: { id: job }, data: { vehicleId: otherAssetId } }),
        ),
      ).rejects.toThrow(/not one organization/);
    });
  });
});
