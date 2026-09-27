import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { createPrismaClient, type PrismaClient } from '@platform/db';
import { SYSTEM_ROLE_IDS } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Locations: one organization with several of them, employee assignment, and
 * location-scoped visibility.
 *
 * Locations are the first entity OWNED BY a tenant rather than BEING one, so
 * this suite is also the template for every business module from Phase 7 on.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  userId: string;
  membershipId: string;
  organizationId: string;
}

describe('Locations (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let appRoleClient: PrismaClient;

  let alphaOwner: Actor;
  let alphaMember: Actor;
  let betaOwner: Actor;

  let downtownId: string;
  let northsideId: string;
  let warehouseId: string;

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

  async function registerOwner(slug: string, orgName: string): Promise<Actor> {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-loc-${slug}@example.test`,
      password: PASSWORD,
      organizationName: orgName,
    });
    expect(response.statusCode, response.body).toBe(201);

    const token = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const userId = json(response).user.id;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId },
    });

    return {
      token,
      userId,
      membershipId: membership.id,
      organizationId: membership.organizationId,
    };
  }

  /**
   * Add a plain MEMBER to an existing organization.
   *
   * Done through the privileged client because invitations do not exist until
   * Phase 4. This is test scaffolding, not a code path the product exposes.
   */
  async function addMember(organizationId: string, slug: string): Promise<Actor> {
    const email = `e2e-loc-${slug}@example.test`;

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `Throwaway Org ${slug}`,
    });
    expect(registration.statusCode).toBe(201);

    const userId = json(registration).user.id;

    // Move them out of the throwaway organization and into the real one.
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Throwaway Org ${slug}` } });

    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });

    // From Phase 4 a membership grants nothing on its own — permission comes
    // from a role assignment. LOCATION scope with no locations yet, so this
    // member starts able to see nothing and gains access only as they are
    // assigned to locations. That is exactly what an invited employee looks
    // like.
    await privileged.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: SYSTEM_ROLE_IDS.employee,
        scope: 'LOCATION',
        organizationId,
      },
    });

    // Re-authenticate so the session reflects the new organization.
    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email,
      password: PASSWORD,
    });
    expect(login.statusCode, login.body).toBe(200);

    return {
      token: login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value,
      userId,
      membershipId: membership.id,
      organizationId,
    };
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-loc-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      `DELETE FROM organizations WHERE name LIKE 'Loc Test%' OR name LIKE 'Throwaway Org%'`,
    );
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    appRoleClient = createPrismaClient({
      databaseUrl: process.env.DATABASE_URL_APP!,
      logErrors: false,
    });

    await cleanUp();

    alphaOwner = await registerOwner('alpha-owner', 'Loc Test Alpha');
    betaOwner = await registerOwner('beta-owner', 'Loc Test Beta');
    alphaMember = await addMember(alphaOwner.organizationId, 'alpha-member');

    // ABC Landscaping with three locations — the shape from the product brief.
    const make = async (name: string) => {
      const response = await request('POST', '/api/v1/locations', alphaOwner.token, {
        name,
        city: 'Springfield',
        timezone: 'America/New_York',
      });
      expect(response.statusCode, response.body).toBe(201);
      return json(response).location.id as string;
    };

    downtownId = await make('Downtown');
    northsideId = await make('Northside');
    warehouseId = await make('Warehouse');

    // The member is assigned to exactly one of the three.
    const assign = await request(
      'POST',
      `/api/v1/locations/${downtownId}/members`,
      alphaOwner.token,
      { membershipId: alphaMember.membershipId },
    );
    expect(assign.statusCode, assign.body).toBe(200);
  });

  afterAll(async () => {
    await cleanUp();
    await appRoleClient?.$disconnect();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('one organization, several locations', () => {
    it('creates locations that all belong to the organization', async () => {
      const response = await request('GET', '/api/v1/locations', alphaOwner.token);
      const { locations } = json(response);

      expect(response.statusCode).toBe(200);
      expect(locations).toHaveLength(3);
      expect(locations.map((l: { name: string }) => l.name)).toEqual([
        'Downtown',
        'Northside',
        'Warehouse',
      ]);
      expect(
        locations.every(
          (l: { organizationId: string }) => l.organizationId === alphaOwner.organizationId,
        ),
      ).toBe(true);
    });

    it('stores the address and timezone', async () => {
      const response = await request('GET', `/api/v1/locations/${downtownId}`, alphaOwner.token);
      const { location } = json(response);

      expect(location.city).toBe('Springfield');
      expect(location.timezone).toBe('America/New_York');
      expect(location.status).toBe('ACTIVE');
    });

    it('rejects an invalid timezone', async () => {
      const response = await request('POST', '/api/v1/locations', alphaOwner.token, {
        name: 'Bad Zone',
        timezone: 'Mars/Olympus_Mons',
      });

      // Appointment times in Phase 9 are meaningless without a real zone.
      expect(response.statusCode).toBe(400);
    });

    it('gives each location a distinct slug', async () => {
      const response = await request('GET', '/api/v1/locations', alphaOwner.token);
      const slugs = json(response).locations.map((l: { slug: string }) => l.slug);

      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('lets a different organization reuse the same location name', async () => {
      const response = await request('POST', '/api/v1/locations', betaOwner.token, {
        name: 'Downtown',
        timezone: 'UTC',
      });

      // Slugs are unique per organization, not globally.
      expect(response.statusCode).toBe(201);
    });

    it('counts active locations for billing', async () => {
      // Phase 6 prices on this number.
      const count = await privileged.location.count({
        where: { organizationId: alphaOwner.organizationId, status: 'ACTIVE' },
      });

      expect(count).toBe(3);
    });
  });

  // -------------------------------------------------------------------------

  describe('location-scoped visibility', () => {
    it('shows an owner every location', async () => {
      const response = await request('GET', '/api/v1/locations', alphaOwner.token);

      expect(json(response).locations).toHaveLength(3);
    });

    it('shows a member only the locations they are assigned to', async () => {
      const response = await request('GET', '/api/v1/locations', alphaMember.token);
      const { locations } = json(response);

      expect(locations).toHaveLength(1);
      expect(locations[0].name).toBe('Downtown');
    });

    it('returns 404 when a member requests an unassigned location', async () => {
      const response = await request('GET', `/api/v1/locations/${northsideId}`, alphaMember.token);

      // 404 rather than 403: a 403 would let an unassigned employee enumerate
      // which locations the business has.
      expect(response.statusCode).toBe(404);
    });

    it('lets a member read a location they are assigned to', async () => {
      const response = await request('GET', `/api/v1/locations/${downtownId}`, alphaMember.token);

      expect(response.statusCode).toBe(200);
      expect(json(response).location.name).toBe('Downtown');
    });

    it('forbids a member from creating a location', async () => {
      const response = await request('POST', '/api/v1/locations', alphaMember.token, {
        name: 'Unauthorised Branch',
        timezone: 'UTC',
      });

      // 403, not 404: the caller demonstrably belongs to this organization, so
      // refusing by permission leaks nothing.
      expect(response.statusCode).toBe(403);
    });

    it('lets an owner fix a name, clear a field, and set a location inactive and back', async () => {
      const id = downtownId;
      const original = json(
        await request('GET', `/api/v1/locations/${id}`, alphaOwner.token),
      ).location;
      const edit = (changes: Record<string, unknown>) =>
        request('PATCH', `/api/v1/locations/${id}`, alphaOwner.token, {
          name: original.name,
          timezone: original.timezone,
          ...changes,
        });

      try {
        const renamed = await edit({ name: 'Tama', city: '' });
        expect(renamed.statusCode, renamed.body).toBe(200);
        expect(json(renamed).location.name).toBe('Tama');
        expect(json(renamed).location.city).toBeNull();

        expect(json(await edit({ name: 'Tampa' })).location.name).toBe('Tampa');
        expect(json(await edit({ status: 'INACTIVE' })).location.status).toBe('INACTIVE');
        expect(json(await edit({ status: 'ACTIVE' })).location.status).toBe('ACTIVE');
      } finally {
        await edit({ city: original.city ?? '', status: original.status });
      }
    });

    it('forbids a member from editing a location they can see', async () => {
      const response = await request(
        'PATCH',
        `/api/v1/locations/${downtownId}`,
        alphaMember.token,
        {
          name: 'Renamed By Member',
          timezone: 'UTC',
        },
      );

      expect(response.statusCode).toBe(403);
    });

    it('forbids a member from assigning colleagues', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${downtownId}/members`,
        alphaMember.token,
        { membershipId: alphaMember.membershipId },
      );

      expect(response.statusCode).toBe(403);
    });

    it('updates visibility the moment an assignment changes', async () => {
      await request('POST', `/api/v1/locations/${warehouseId}/members`, alphaOwner.token, {
        membershipId: alphaMember.membershipId,
      });

      const after = await request('GET', '/api/v1/locations', alphaMember.token);
      expect(json(after).locations).toHaveLength(2);

      await request(
        'DELETE',
        `/api/v1/locations/${warehouseId}/members/${alphaMember.membershipId}`,
        alphaOwner.token,
      );

      const restored = await request('GET', '/api/v1/locations', alphaMember.token);
      expect(json(restored).locations).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------

  describe('assignment', () => {
    it('lists assigned members', async () => {
      const response = await request(
        'GET',
        `/api/v1/locations/${downtownId}/members`,
        alphaOwner.token,
      );

      expect(response.statusCode).toBe(200);
      expect(json(response).members).toHaveLength(1);
      expect(json(response).members[0].email).toBe('e2e-loc-alpha-member@example.test');
    });

    it('treats a repeated assignment as already satisfied', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${downtownId}/members`,
        alphaOwner.token,
        { membershipId: alphaMember.membershipId },
      );

      expect(response.statusCode).toBe(200);
      expect(json(response).members).toHaveLength(1);
    });

    it('refuses to assign a member from another organization', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${downtownId}/members`,
        alphaOwner.token,
        { membershipId: betaOwner.membershipId },
      );

      // Beta's membership row is invisible under Alpha's tenant context, so
      // the lookup finds nothing — there is no code path that could succeed.
      expect(response.statusCode).toBe(404);
    });

    it('removes every location assignment when someone leaves the organization', async () => {
      const leaver = await addMember(alphaOwner.organizationId, 'leaver');

      await request('POST', `/api/v1/locations/${northsideId}/members`, alphaOwner.token, {
        membershipId: leaver.membershipId,
      });

      expect(
        await privileged.locationMembership.count({ where: { membershipId: leaver.membershipId } }),
      ).toBe(1);

      await privileged.organizationMembership.delete({ where: { id: leaver.membershipId } });

      // Cascade, not a cleanup routine that can be forgotten.
      expect(
        await privileged.locationMembership.count({ where: { membershipId: leaver.membershipId } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('hides one organization’s locations from another', async () => {
      const response = await request('GET', '/api/v1/locations', betaOwner.token);
      const names = json(response).locations.map((l: { name: string }) => l.name);

      expect(names).not.toContain('Northside');
      expect(names).not.toContain('Warehouse');
    });

    it('returns 404 for another organization’s location by id', async () => {
      const response = await request('GET', `/api/v1/locations/${downtownId}`, betaOwner.token);

      expect(response.statusCode).toBe(404);
    });

    it('makes it indistinguishable from a location that does not exist', async () => {
      const other = await request('GET', `/api/v1/locations/${downtownId}`, betaOwner.token);
      const missing = await request(
        'GET',
        '/api/v1/locations/00000000-0000-4000-8000-000000000000',
        betaOwner.token,
      );

      expect(other.statusCode).toBe(missing.statusCode);
      expect(json(other).message).toBe(json(missing).message);
    });

    it('refuses a cross-organization edit', async () => {
      const response = await request('PATCH', `/api/v1/locations/${downtownId}`, betaOwner.token, {
        name: 'Hijacked',
        timezone: 'UTC',
      });

      expect(response.statusCode).toBe(404);

      const unchanged = await privileged.location.findUnique({ where: { id: downtownId } });
      expect(unchanged?.name).toBe('Downtown');
    });

    it('row-level security hides locations from a raw unscoped query', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_organization_id = '${betaOwner.organizationId}'`,
        );
        // No WHERE clause — the forgotten-predicate bug, on purpose.
        return tx.$queryRawUnsafe<Array<{ organization_id: string }>>(
          'SELECT organization_id FROM locations',
        );
      });

      expect(rows.every((r) => r.organization_id === betaOwner.organizationId)).toBe(true);
      expect(rows.map((r) => r.organization_id)).not.toContain(alphaOwner.organizationId);
    });

    it('row-level security refuses to write a location into another tenant', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_organization_id = '${betaOwner.organizationId}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO locations (id, organization_id, name, slug, timezone, status, created_at, updated_at)
             VALUES (gen_random_uuid(), '${alphaOwner.organizationId}', 'Injected', 'injected', 'UTC', 'ACTIVE', now(), now())`,
          );
        }),
      ).rejects.toThrow();
    });

    it('rejects a location membership whose organization disagrees with its location', async () => {
      // The policy alone would accept this: organization_id matches the tenant
      // context. Only the trigger catches that the LOCATION belongs elsewhere.
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_organization_id = '${betaOwner.organizationId}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO location_memberships (id, membership_id, location_id, organization_id, created_at)
             VALUES (gen_random_uuid(), '${betaOwner.membershipId}', '${downtownId}', '${betaOwner.organizationId}', now())`,
          );
        }),
      ).rejects.toThrow();
    });
  });
});
