import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Roles and scoped permissions.
 *
 * The scenario the whole model exists for: a Location Manager who runs SOME
 * locations and must be powerless at the others. A flat role cannot express
 * that, and this suite is what proves the scoped one does.
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
}

describe('Roles and permissions (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let manager: Actor;
  let employee: Actor;

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

  /**
   * Add someone to the organization with a specific role and scope.
   *
   * Uses the privileged client because the invitation flow does not exist yet.
   * This is test scaffolding standing in for what an invitation will do.
   */
  async function addPerson(
    slug: string,
    roleId: string,
    scope: 'ORGANIZATION' | 'LOCATION',
    locationIds: string[] = [],
  ): Promise<Actor> {
    const email = `e2e-rbac-${slug}@example.test`;

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `RBAC Throwaway ${slug}`,
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `RBAC Throwaway ${slug}` } });

    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });

    const assignment = await privileged.membershipRole.create({
      data: { membershipId: membership.id, roleId, scope, organizationId },
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
    expect(login.statusCode, login.body).toBe(200);

    return {
      token: login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value,
      userId,
      membershipId: membership.id,
    };
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-rbac-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'RBAC %'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    // The administrator, created the ordinary way.
    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-rbac-admin@example.test',
      password: PASSWORD,
      organizationName: 'RBAC Test Company',
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const adminMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = adminMembership.organizationId;

    admin = {
      token: registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value,
      userId: json(registration).user.id,
      membershipId: adminMembership.id,
    };

    const make = async (name: string) => {
      const response = await request('POST', '/api/v1/locations', admin.token, {
        name,
        timezone: 'UTC',
      });
      expect(response.statusCode, response.body).toBe(201);
      return json(response).location.id as string;
    };

    downtownId = await make('Downtown');
    northsideId = await make('Northside');
    warehouseId = await make('Warehouse');

    // Manages Downtown and Northside. NOT Warehouse.
    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, 'LOCATION', [
      downtownId,
      northsideId,
    ]);

    // Works at Downtown only.
    employee = await addPerson('employee', SYSTEM_ROLE_IDS.employee, 'LOCATION', [downtownId]);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('the administrator', () => {
    it('holds every permission organization-wide', async () => {
      const response = await request('GET', '/api/v1/organizations/current', admin.token);
      const { permissions, roles } = json(response);

      expect(roles).toEqual(['org_admin']);
      expect(permissions.organizationWide).toContain('location.write');
      expect(permissions.organizationWide).toContain('organization.write');
      expect(permissions.organizationWide).toContain('member.manage');
    });

    it('sees every location', async () => {
      const response = await request('GET', '/api/v1/locations', admin.token);

      expect(json(response).locations).toHaveLength(3);
    });

    it('can rename the organization', async () => {
      const response = await request('PATCH', '/api/v1/organizations/current', admin.token, {
        name: 'RBAC Test Company Renamed',
      });

      expect(response.statusCode).toBe(200);

      await request('PATCH', '/api/v1/organizations/current', admin.token, {
        name: 'RBAC Test Company',
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('the Location Manager', () => {
    it('holds location permissions scoped, never organization-wide', async () => {
      const response = await request('GET', '/api/v1/organizations/current', manager.token);
      const { permissions } = json(response);

      // The distinction the model exists for.
      expect(permissions.organizationWide).not.toContain('location.write');
      expect(permissions.byLocation['location.read'].sort()).toEqual(
        [downtownId, northsideId].sort(),
      );
    });

    it('sees only the locations they manage', async () => {
      const response = await request('GET', '/api/v1/locations', manager.token);
      const names = json(response).locations.map((l: { name: string }) => l.name);

      expect(names.sort()).toEqual(['Downtown', 'Northside']);
      expect(names).not.toContain('Warehouse');
    });

    it('can edit a location they manage', async () => {
      const response = await request('PATCH', `/api/v1/locations/${downtownId}`, manager.token, {
        name: 'Downtown Renamed',
        timezone: 'UTC',
      });

      expect(response.statusCode, response.body).toBe(200);

      await request('PATCH', `/api/v1/locations/${downtownId}`, manager.token, {
        name: 'Downtown',
        timezone: 'UTC',
      });
    });

    it('CANNOT edit a location they do not manage', async () => {
      const response = await request('PATCH', `/api/v1/locations/${warehouseId}`, manager.token, {
        name: 'Hijacked',
        timezone: 'UTC',
      });

      // 404, not 403: a 403 would confirm Warehouse exists, letting an
      // unassigned manager enumerate the company's locations.
      expect(response.statusCode).toBe(404);

      const unchanged = await privileged.location.findUnique({ where: { id: warehouseId } });
      expect(unchanged?.name).toBe('Warehouse');
    });

    it('CANNOT create a location', async () => {
      const response = await request('POST', '/api/v1/locations', manager.token, {
        name: 'Unauthorised Branch',
        timezone: 'UTC',
      });

      // Creating a location adds a billable unit. That is a company decision,
      // so it needs the permission organization-wide — which a scoped manager
      // does not have.
      expect(response.statusCode).toBe(403);
    });

    it('CANNOT rename the organization', async () => {
      const response = await request('PATCH', '/api/v1/organizations/current', manager.token, {
        name: 'Manager Renamed This',
      });

      expect(response.statusCode).toBe(403);

      const unchanged = await privileged.organization.findUnique({ where: { id: organizationId } });
      expect(unchanged?.name).toBe('RBAC Test Company');
    });

    it('can assign people at a location they manage', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${northsideId}/members`,
        manager.token,
        { membershipId: employee.membershipId },
      );

      expect(response.statusCode, response.body).toBe(200);

      await request(
        'DELETE',
        `/api/v1/locations/${northsideId}/members/${employee.membershipId}`,
        manager.token,
      );
    });

    it('CANNOT assign people at a location they do not manage', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${warehouseId}/members`,
        manager.token,
        { membershipId: employee.membershipId },
      );

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('the Employee', () => {
    it('sees only where they work', async () => {
      const response = await request('GET', '/api/v1/locations', employee.token);
      const names = json(response).locations.map((l: { name: string }) => l.name);

      expect(names).toEqual(['Downtown']);
    });

    it('can read their own location', async () => {
      const response = await request('GET', `/api/v1/locations/${downtownId}`, employee.token);

      expect(response.statusCode).toBe(200);
    });

    it('CANNOT read a location they are not assigned to', async () => {
      const response = await request('GET', `/api/v1/locations/${northsideId}`, employee.token);

      expect(response.statusCode).toBe(404);
    });

    it('CANNOT edit even their own location', async () => {
      const response = await request('PATCH', `/api/v1/locations/${downtownId}`, employee.token, {
        name: 'Employee Renamed',
        timezone: 'UTC',
      });

      // Employee holds location.read but not location.write.
      expect(response.statusCode).toBe(403);
    });

    it('CANNOT create a location', async () => {
      const response = await request('POST', '/api/v1/locations', employee.token, {
        name: 'Employee Branch',
        timezone: 'UTC',
      });

      expect(response.statusCode).toBe(403);
    });

    it('CANNOT assign colleagues anywhere', async () => {
      const response = await request(
        'POST',
        `/api/v1/locations/${downtownId}/members`,
        employee.token,
        { membershipId: employee.membershipId },
      );

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('assignment keeps staffing and permission in step', () => {
    it('grants visibility when someone is assigned to a location', async () => {
      const before = await request('GET', '/api/v1/locations', employee.token);
      expect(json(before).locations).toHaveLength(1);

      await request('POST', `/api/v1/locations/${warehouseId}/members`, admin.token, {
        membershipId: employee.membershipId,
      });

      // One user-facing action produces both records. Otherwise an owner would
      // assign someone to a branch and find they still could not see it, with
      // no obvious way to fix that.
      const after = await request('GET', '/api/v1/locations', employee.token);
      expect(json(after).locations).toHaveLength(2);
    });

    it('withdraws visibility when the assignment is removed', async () => {
      await request(
        'DELETE',
        `/api/v1/locations/${warehouseId}/members/${employee.membershipId}`,
        admin.token,
      );

      const after = await request('GET', '/api/v1/locations', employee.token);
      const names = json(after).locations.map((l: { name: string }) => l.name);

      expect(names).toEqual(['Downtown']);
    });
  });

  // -------------------------------------------------------------------------

  describe('privilege escalation', () => {
    it('a member cannot grant themselves a role through the API', async () => {
      // No endpoint exposes role assignment yet, so the surface simply does not
      // exist. This asserts that remains true rather than assuming it.
      const response = await request('POST', '/api/v1/organizations/current/roles', manager.token, {
        membershipId: manager.membershipId,
        roleKey: 'org_admin',
        scope: 'ORGANIZATION',
      });

      expect([403, 404]).toContain(response.statusCode);
    });

    it('the permission set reflects the database, not the request', async () => {
      // Confirms permissions are resolved server-side per request rather than
      // trusted from anything the client sends.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations',
        cookies: { [SESSION_COOKIE_NAME]: employee.token },
        headers: { 'x-permissions': JSON.stringify({ organizationWide: ['location.write'] }) },
      });

      const body = JSON.parse(response.body);
      expect(body.locations).toHaveLength(1);
    });

    it('revoking a role takes effect on the very next request', async () => {
      const before = await request('GET', '/api/v1/locations', manager.token);
      expect(json(before).locations.length).toBeGreaterThan(0);

      await privileged.membershipRole.deleteMany({ where: { membershipId: manager.membershipId } });

      // Permissions are resolved per request, not cached on the session — the
      // same reasoning that made sessions preferable to stateless tokens.
      const after = await request('GET', '/api/v1/locations', manager.token);
      expect(after.statusCode).toBe(403);
    });
  });
});
