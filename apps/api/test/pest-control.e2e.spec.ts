import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Materials used on jobs, and the Pest Control pack's application records.
 *
 * The parts that carry the design:
 *
 *   - a pack adds its fields to a core record, and the core only checks them
 *     against the pack's own schema
 *   - the crew on a job records what they applied, whatever their role
 *   - a record copies the license and registration number as they were, and
 *     is voided, never edited or deleted, and neither is its job
 *   - switching the pack off hides the records and keeps them
 */

const PASSWORD = 'a-sufficiently-long-password';
const PEST = MODULES.PEST_CONTROL;

const dayFromNow = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

const treatment = {
  targetPests: ['Ants', 'Cockroaches'],
  areas: ['Kitchen', 'Exterior perimeter'],
  method: 'Spray',
  mixRate: '0.8 fl oz per gallon',
  windMph: 4,
  temperatureF: 84,
};

// A tiny valid PNG, as a data URL.
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Pest Control (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let privileged: PrismaClient;

  let organizationId: string;
  let adminUserId: string;
  let admin: Actor;
  let tech: Actor;
  let bystander: Actor;
  let northTech: Actor;
  let northManager: Actor;

  let downtownId: string;
  let itemId: string;
  let branchPlaceId: string;

  let otherToken: string;
  let otherJobId: string;

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

  let jobCounter = 0;
  async function newJob(overrides: Record<string, unknown> = {}): Promise<string> {
    jobCounter += 1;
    const start = new Date(Date.UTC(2026, 8, 7, 8 + (jobCounter % 10)));
    const response = await request('POST', '/api/v1/jobs', admin.token, {
      title: `Quarterly service ${jobCounter}`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      locationId: downtownId,
      assigneeMembershipIds: [tech.membershipId],
      // Many visits for one tech; the clash warning is not under test here.
      acknowledgeConflicts: true,
      ...overrides,
    });
    expect(response.statusCode, response.body).toBe(201);
    return json(response).job.id;
  }

  const record = (token: string, jobId: string, body: Record<string, unknown> = {}) =>
    request('POST', `/api/v1/inventory/jobs/${jobId}/materials`, token, {
      itemId,
      quantity: 2,
      packFields: { [PEST]: treatment },
      ...body,
    });

  const onHand = async (placeId: string) => {
    const item = json(await request('GET', `/api/v1/inventory/items/${itemId}`, admin.token)).item;
    return item.places.find((p: { placeId: string }) => p.placeId === placeId)?.onHand ?? 0;
  };

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-pest-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Pest Test%'");
  }

  async function register(slug: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-pest-${slug}@example.test`,
      password: PASSWORD,
      organizationName,
    });
    return { token: tokenOf(response), userId: json(response).user.id as string };
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const { userId } = await register(slug, `Pest Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Pest Test Throwaway ${slug}` } });
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
      email: `e2e-pest-${slug}@example.test`,
      password: PASSWORD,
    });
    return { token: tokenOf(login), membershipId: membership.id };
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const owner = await register('admin', 'Pest Test Company');
    adminUserId = owner.userId;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: adminUserId },
    });
    organizationId = membership.organizationId;
    admin = { token: owner.token, membershipId: membership.id };

    expect((await request('POST', `/api/v1/modules/${PEST}`, admin.token)).statusCode).toBe(200);

    downtownId = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Downtown',
        timezone: 'America/New_York',
      }),
    ).location.id;
    const northsideId = json(
      await request('POST', '/api/v1/locations', admin.token, {
        name: 'Northside',
        timezone: 'America/New_York',
      }),
    ).location.id;

    tech = await addPerson('tech', SYSTEM_ROLE_IDS.employee, [downtownId]);
    bystander = await addPerson('bystander', SYSTEM_ROLE_IDS.employee, [downtownId]);
    northTech = await addPerson('northtech', SYSTEM_ROLE_IDS.employee, [northsideId]);
    northManager = await addPerson('northmanager', SYSTEM_ROLE_IDS.location_manager, [northsideId]);

    const item = await request('POST', '/api/v1/inventory/items', admin.token, {
      name: 'Termidor SC',
      unit: 'fl oz',
      packFields: {
        [PEST]: { epaRegistrationNumber: '7969-210', activeIngredient: 'Fipronil 9.1%' },
      },
    });
    expect(item.statusCode, item.body).toBe(201);
    itemId = json(item).id;

    branchPlaceId = (
      await privileged.stockPlace.findFirstOrThrow({
        where: { locationId: downtownId, kind: 'BRANCH' },
      })
    ).id;
    await request('POST', '/api/v1/inventory/changes', admin.token, {
      action: 'receive',
      itemId,
      placeId: branchPlaceId,
      quantity: 500,
    });

    const license = await request(
      'PUT',
      `/api/v1/organizations/current/members/${tech.membershipId}/pack-fields`,
      admin.token,
      { packFields: { [PEST]: { licenseNumber: 'JF123456', licenseExpiresOn: '2027-06-30' } } },
    );
    expect(license.statusCode, license.body).toBe(200);

    const other = await register('other', 'Pest Test Competitor');
    otherToken = other.token;
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, otherToken);
    otherJobId = json(
      await request('POST', '/api/v1/jobs', otherToken, {
        title: 'Rival visit',
        startsAt: '2026-09-07T09:00:00.000Z',
        endsAt: '2026-09-07T10:00:00.000Z',
      }),
    ).job.id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('pack fields on core records', () => {
    it('keeps what the pack adds to an item', async () => {
      const item = json(
        await request('GET', `/api/v1/inventory/items/${itemId}`, admin.token),
      ).item;
      expect(item.packFields[PEST]).toMatchObject({ epaRegistrationNumber: '7969-210' });
    });

    it('refuses fields for a pack the business does not have', async () => {
      const response = await request('POST', '/api/v1/inventory/items', admin.token, {
        name: 'Mystery product',
        unit: 'each',
        packFields: { lawn_care: { grassType: 'St. Augustine' } },
      });
      expect(response.statusCode).toBe(400);
    });

    it('merges a change to someone’s license rather than replacing it', async () => {
      await request(
        'PUT',
        `/api/v1/organizations/current/members/${bystander.membershipId}/pack-fields`,
        admin.token,
        { packFields: { [PEST]: { licenseNumber: 'JF999' } } },
      );
      const after = await request(
        'PUT',
        `/api/v1/organizations/current/members/${bystander.membershipId}/pack-fields`,
        admin.token,
        { packFields: { [PEST]: { licenseExpiresOn: '2028-01-31' } } },
      );
      expect(json(after).packFields[PEST]).toEqual({
        licenseNumber: 'JF999',
        licenseExpiresOn: '2028-01-31',
      });
    });

    it('lets only people managers set a license', async () => {
      const response = await request(
        'PUT',
        `/api/v1/organizations/current/members/${tech.membershipId}/pack-fields`,
        tech.token,
        { packFields: { [PEST]: { licenseNumber: 'FORGED' } } },
      );
      expect(response.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('application records', () => {
    it('lets the crew record what they applied, as a full record', async () => {
      const jobId = await newJob();
      const before = await onHand(branchPlaceId);

      const response = await record(tech.token, jobId);
      expect(response.statusCode, response.body).toBe(201);

      const [line] = json(response).materials;
      expect(line).toMatchObject({ itemName: 'Termidor SC', quantity: 2, voided: null });
      expect(line.packFields[PEST]).toMatchObject({
        targetPests: ['Ants', 'Cockroaches'],
        method: 'Spray',
        mixRate: '0.8 fl oz per gallon',
        windMph: 4,
        productName: 'Termidor SC',
        epaRegistrationNumber: '7969-210',
        applicatorMembershipId: tech.membershipId,
        applicatorLicense: 'JF123456',
        applicatorLicenseExpiresOn: '2027-06-30',
      });
      expect(await onHand(branchPlaceId)).toBe(before - 2);
    });

    it('insists on the pack’s fields while the pack is on', async () => {
      const jobId = await newJob();
      const bare = await request('POST', `/api/v1/inventory/jobs/${jobId}/materials`, tech.token, {
        itemId,
        quantity: 1,
      });
      expect(bare.statusCode).toBe(400);

      const noPest = await record(tech.token, jobId, {
        packFields: { [PEST]: { ...treatment, targetPests: [] } },
      });
      expect(noPest.statusCode).toBe(400);
    });

    it('refuses someone not on the crew, and hides the job from another branch', async () => {
      const jobId = await newJob();
      expect((await record(bystander.token, jobId)).statusCode).toBe(403);
      expect((await record(northTech.token, jobId)).statusCode).toBe(404);
    });

    it('keeps the license and registration number as they were on the day', async () => {
      const jobId = await newJob();
      await record(tech.token, jobId);

      await request('PATCH', `/api/v1/inventory/items/${itemId}`, admin.token, {
        packFields: { [PEST]: { epaRegistrationNumber: '7969-999' } },
      });
      await request(
        'PUT',
        `/api/v1/organizations/current/members/${tech.membershipId}/pack-fields`,
        admin.token,
        { packFields: { [PEST]: { licenseNumber: 'JF-RENEWED' } } },
      );

      const [line] = json(
        await request('GET', `/api/v1/inventory/jobs/${jobId}/materials`, tech.token),
      ).materials;
      expect(line.packFields[PEST]).toMatchObject({
        epaRegistrationNumber: '7969-210',
        applicatorLicense: 'JF123456',
      });

      // Put them back for the tests that follow.
      await request('PATCH', `/api/v1/inventory/items/${itemId}`, admin.token, {
        packFields: { [PEST]: { epaRegistrationNumber: '7969-210' } },
      });
      await request(
        'PUT',
        `/api/v1/organizations/current/members/${tech.membershipId}/pack-fields`,
        admin.token,
        { packFields: { [PEST]: { licenseNumber: 'JF123456' } } },
      );
    });

    it('takes the product off the job’s vehicle when it has one', async () => {
      const van = json(
        await request('POST', '/api/v1/fleet/assets', admin.token, {
          name: 'Pest Van',
          kind: 'VEHICLE',
          locationId: downtownId,
          meter: 'MILES',
        }),
      );
      await request('POST', '/api/v1/inventory/changes', admin.token, {
        action: 'receive',
        itemId,
        placeId: van.stockPlaceId,
        quantity: 20,
      });
      const jobId = await newJob();
      await request('PUT', `/api/v1/fleet/jobs/${jobId}/vehicle`, admin.token, {
        vehicleId: van.id,
      });

      const [line] = json(await record(tech.token, jobId, { quantity: 3 })).materials;
      expect(line.placeId).toBe(van.stockPlaceId);
      expect(await onHand(van.stockPlaceId)).toBe(17);
    });
  });

  // =========================================================================

  describe('keeping records', () => {
    it('voids a line with a reason, puts the stock back, and keeps both', async () => {
      const jobId = await newJob();
      const [line] = json(await record(tech.token, jobId, { quantity: 5 })).materials;
      const before = await onHand(branchPlaceId);

      const voided = await request(
        'POST',
        `/api/v1/inventory/materials/${line.id}/void`,
        tech.token,
        {
          reason: 'Wrong product scanned',
        },
      );
      expect(voided.statusCode, voided.body).toBe(204);
      expect(await onHand(branchPlaceId)).toBe(before + 5);

      const [after] = json(
        await request('GET', `/api/v1/inventory/jobs/${jobId}/materials`, tech.token),
      ).materials;
      expect(after.voided).toMatchObject({ reason: 'Wrong product scanned' });

      const again = await request(
        'POST',
        `/api/v1/inventory/materials/${line.id}/void`,
        tech.token,
        {
          reason: 'Twice',
        },
      );
      expect(again.statusCode).toBe(409);
    });

    it('refuses to delete a job with records on it', async () => {
      const jobId = await newJob();
      await record(tech.token, jobId);

      const response = await request('DELETE', `/api/v1/jobs/${jobId}`, admin.token);
      expect(response.statusCode).toBe(409);
      expect(json(response).code).toBe('JOB_HAS_RECORDS');
    });

    it('keeps a series visit with records when the series changes', async () => {
      const series = await request('POST', '/api/v1/job-series', admin.token, {
        title: 'Quarterly plan',
        frequency: 'WEEKLY',
        interval: 1,
        startMinutes: 9 * 60,
        durationMinutes: 60,
        locationId: downtownId,
        startsOn: dayFromNow(1),
      });
      expect(series.statusCode, series.body).toBe(201);
      const seriesId = json(series).series.id;
      const visits = await privileged.job.findMany({
        where: { seriesId },
        orderBy: { startsAt: 'asc' },
        select: { id: true },
      });
      const worked = visits[1]!.id;
      // Recorded by a manager, and nothing else done to the visit: editing it
      // (to add a crew, say) would mark it touched by itself and prove nothing.
      expect((await record(admin.token, worked)).statusCode).toBe(201);

      // Every other week now: the untouched visit in between would go.
      const changed = await request('PATCH', `/api/v1/job-series/${seriesId}`, admin.token, {
        interval: 2,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(await privileged.job.count({ where: { id: worked } })).toBe(1);
    });

    it('takes a customer signature from the crew, and never changes it', async () => {
      const jobId = await newJob();
      const signed = await request('POST', `/api/v1/jobs/${jobId}/signoff`, tech.token, {
        signerName: 'Dana Diaz',
        image: SIGNATURE,
      });
      expect(signed.statusCode, signed.body).toBe(201);

      const shown = json(
        await request('GET', `/api/v1/jobs/${jobId}/signoff`, admin.token),
      ).signoff;
      expect(shown).toMatchObject({ signerName: 'Dana Diaz', image: SIGNATURE });

      expect(
        (
          await request('POST', `/api/v1/jobs/${jobId}/signoff`, bystander.token, {
            signerName: 'Someone',
            image: SIGNATURE,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await request('POST', `/api/v1/jobs/${jobId}/signoff`, tech.token, {
            signerName: 'Dana Diaz',
            image: 'data:text/html;base64,PHNjcmlwdD4=',
          })
        ).statusCode,
      ).toBe(400);

      const context = { organizationId, userId: adminUserId };
      await expect(
        prisma.withTenant(context, (tx) =>
          tx.jobSignoff.updateMany({ where: { jobId }, data: { signerName: 'Forged' } }),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withTenant(context, (tx) => tx.jobSignoff.deleteMany({ where: { jobId } })),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // =========================================================================

  describe('the records themselves', () => {
    it('lists and exports them, with the customer and product', async () => {
      const customer = json(
        await request('POST', '/api/v1/customers', admin.token, {
          type: 'PERSON',
          firstName: '=HYPERLINK("http://evil.test")',
          stage: 'ACTIVE',
          locationId: downtownId,
        }),
      ).customer;
      const jobId = await newJob({ customerId: customer.id });
      await record(tech.token, jobId);

      const list = json(
        await request('GET', `/api/v1/packs/pest-control/records?jobId=${jobId}`, admin.token),
      ).records;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ jobId, customerId: customer.id, quantity: 2, voided: false });

      const csv = await request(
        'GET',
        `/api/v1/packs/pest-control/records.csv?jobId=${jobId}`,
        admin.token,
      );
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain('7969-210');
      // Dated in the branch's own day, the one an inspector asks about.
      expect(csv.body).toContain('America/New_York');
      expect(csv.body).toContain('Ants; Cockroaches');
      // A name that looks like a formula is defused before a spreadsheet sees it.
      expect(csv.body).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
    });

    it('shows a branch manager only their branches’ records', async () => {
      const jobId = await newJob();
      await record(tech.token, jobId);

      const theirs = json(
        await request(
          'GET',
          `/api/v1/packs/pest-control/records?jobId=${jobId}`,
          northManager.token,
        ),
      ).records;
      expect(theirs).toHaveLength(0);
    });

    it('never shows another business’s job, however it is asked for', async () => {
      expect(
        (await request('GET', `/api/v1/inventory/jobs/${otherJobId}/materials`, admin.token))
          .statusCode,
      ).toBe(404);
      expect((await record(admin.token, otherJobId)).statusCode).toBe(404);
      expect(
        json(
          await request(
            'GET',
            `/api/v1/packs/pest-control/records?jobId=${otherJobId}`,
            admin.token,
          ),
        ).records,
      ).toHaveLength(0);
    });
  });

  // =========================================================================

  describe('switching the pack off', () => {
    it('hides the records and keeps every one', async () => {
      const jobId = await newJob();
      await record(tech.token, jobId);
      const kept = await privileged.stockMovement.count({ where: { jobId } });

      const off = await request('DELETE', `/api/v1/modules/${PEST}`, admin.token);
      expect(off.statusCode, off.body).toBe(200);

      expect(
        (await request('GET', '/api/v1/packs/pest-control/records', admin.token)).statusCode,
      ).toBe(403);
      // Materials can still be recorded, without the pack's fields.
      const plain = await request('POST', `/api/v1/inventory/jobs/${jobId}/materials`, tech.token, {
        itemId,
        quantity: 1,
      });
      expect(plain.statusCode, plain.body).toBe(201);
      expect(await privileged.stockMovement.count({ where: { jobId } })).toBe(kept + 1);

      expect((await request('POST', `/api/v1/modules/${PEST}`, admin.token)).statusCode).toBe(200);
    });
  });
});
