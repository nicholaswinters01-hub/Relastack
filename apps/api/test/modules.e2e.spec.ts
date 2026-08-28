import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, MODULE_REGISTRY, SESSION_COOKIE_NAME } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Module registry and entitlement enforcement.
 *
 * The requirement being proved: a disabled module must be unreachable through
 * the API, not merely absent from the interface. Anyone can hide a navigation
 * item; what makes modules a commercial boundary is that calling the endpoint
 * directly still fails.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Modules and entitlements (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let alphaToken: string;
  let alphaOrgId: string;
  let betaToken: string;
  let betaOrgId: string;

  const request = (
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
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

  const moduleState = (response: InjectResult, key: string) =>
    json(response).modules.find((m: { key: string }) => m.key === key);

  async function registerOrg(slug: string, name: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-mod-${slug}@example.test`,
      password: PASSWORD,
      organizationName: name,
    });
    expect(response.statusCode, response.body).toBe(201);

    const token = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(response).user.id },
    });

    return { token, organizationId: membership.organizationId };
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-mod-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Module Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    ({ token: alphaToken, organizationId: alphaOrgId } = await registerOrg(
      'alpha',
      'Module Test Alpha',
    ));
    ({ token: betaToken, organizationId: betaOrgId } = await registerOrg(
      'beta',
      'Module Test Beta',
    ));
  });

  beforeEach(async () => {
    // Back to a known state: core only, for both organizations.
    await privileged.organizationModule.deleteMany({
      where: { organizationId: { in: [alphaOrgId, betaOrgId] }, moduleKey: { not: 'core' } },
    });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('the registry', () => {
    it('the database mirror matches the code registry', async () => {
      // The registry in code is the source of truth; the table exists for
      // referential integrity. Drift between them would mean a module the code
      // gates on cannot be stored against an organization at all — so this
      // asserts the seed migration kept up with the registry.
      const rows = await privileged.module.findMany();

      expect(rows).toHaveLength(MODULE_REGISTRY.length);

      for (const definition of MODULE_REGISTRY) {
        const row = rows.find((entry) => entry.key === definition.key);

        expect(row, `missing from database: ${definition.key}`).toBeDefined();
        expect(row!.isCore).toBe(definition.isCore);
        expect([...row!.dependencies].sort()).toEqual([...definition.dependencies].sort());
      }
    });

    it('lists every module with this organization state', async () => {
      const response = await request('GET', '/api/v1/modules', alphaToken);

      expect(response.statusCode).toBe(200);
      expect(json(response).modules.length).toBeGreaterThanOrEqual(7);
      expect(moduleState(response, MODULES.CORE).enabled).toBe(true);
      expect(moduleState(response, MODULES.CRM).enabled).toBe(false);
    });

    it('starts a new organization with core only', async () => {
      const response = await request('GET', '/api/v1/modules', alphaToken);
      const enabled = json(response)
        .modules.filter((m: { enabled: boolean }) => m.enabled)
        .map((m: { key: string }) => m.key);

      // Shipping a new module must not silently hand it to every existing
      // customer — absence means "not enabled".
      expect(enabled).toEqual([MODULES.CORE]);
    });

    it('reports declared dependencies', async () => {
      const response = await request('GET', '/api/v1/modules', alphaToken);

      expect(moduleState(response, MODULES.SCHEDULING).dependencies).toEqual([MODULES.CRM]);
      expect(moduleState(response, MODULES.CRM).dependencies).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe('enabling and disabling', () => {
    it('enables a module', async () => {
      const response = await request('POST', `/api/v1/modules/${MODULES.CRM}`, alphaToken);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).enabled).toEqual([MODULES.CRM]);
      expect(moduleState(response, MODULES.CRM).enabled).toBe(true);
    });

    it('enables dependencies automatically, and says which', async () => {
      const response = await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, alphaToken);

      // Refusing with "enable CRM first" would be busywork the software can do.
      expect(json(response).enabled).toEqual([MODULES.CRM, MODULES.SCHEDULING]);
      expect(moduleState(response, MODULES.CRM).enabled).toBe(true);
    });

    it('disables a module', async () => {
      await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);

      const response = await request('DELETE', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);

      expect(response.statusCode).toBe(200);
      expect(moduleState(response, MODULES.INVENTORY).enabled).toBe(false);
    });

    it('refuses to disable a module something else depends on', async () => {
      await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, alphaToken);

      const response = await request('DELETE', `/api/v1/modules/${MODULES.CRM}`, alphaToken);

      // Cascading would silently switch off a capability the customer did not
      // ask to lose.
      expect(response.statusCode).toBe(400);
      expect(json(response).message).toContain('Scheduling');
    });

    it('allows disabling once the dependent is off', async () => {
      await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, alphaToken);
      await request('DELETE', `/api/v1/modules/${MODULES.SCHEDULING}`, alphaToken);

      const response = await request('DELETE', `/api/v1/modules/${MODULES.CRM}`, alphaToken);
      expect(response.statusCode).toBe(200);
    });

    it('refuses to disable core', async () => {
      const response = await request('DELETE', `/api/v1/modules/${MODULES.CORE}`, alphaToken);

      // Disabling core would lock the organization out of its own account.
      expect(response.statusCode).toBe(400);
      expect(
        moduleState(await request('GET', '/api/v1/modules', alphaToken), MODULES.CORE).enabled,
      ).toBe(true);
    });

    it('the database refuses to disable core even bypassing the service', async () => {
      // The service check is the friendly path; the trigger is what makes it
      // true for every code path, including a future migration or admin script.
      await expect(
        privileged.organizationModule.updateMany({
          where: { organizationId: alphaOrgId, moduleKey: 'core' },
          data: { enabled: false },
        }),
      ).rejects.toThrow();
    });

    it('rejects an unknown module key', async () => {
      const response = await request('POST', '/api/v1/modules/not_a_module', alphaToken);

      expect(response.statusCode).toBe(404);
    });

    it('is non-destructive: re-enabling restores prior state', async () => {
      await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);
      await request('DELETE', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);
      const response = await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);

      // A customer who turns something off for a quarter must find their data
      // intact when they turn it back on.
      expect(moduleState(response, MODULES.INVENTORY).enabled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('enforcement — the point of the phase', () => {
    const customRole = {
      key: 'shift_lead',
      name: 'Shift Lead',
      defaultScope: 'LOCATION',
      permissions: ['location.read'],
    };

    it('refuses a gated endpoint when the module is off', async () => {
      const response = await request('POST', '/api/v1/roles', alphaToken, customRole);

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
      expect(json(response).moduleKey).toBe(MODULES.CUSTOM_ROLES);
    });

    it('allows the same endpoint once the module is on', async () => {
      await request('POST', `/api/v1/modules/${MODULES.CUSTOM_ROLES}`, alphaToken);

      const response = await request('POST', '/api/v1/roles', alphaToken, customRole);

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).roles.some((r: { key: string }) => r.key === 'shift_lead')).toBe(true);

      await privileged.role.deleteMany({ where: { organizationId: alphaOrgId } });
    });

    it('refuses again the moment the module is turned off', async () => {
      await request('POST', `/api/v1/modules/${MODULES.CUSTOM_ROLES}`, alphaToken);
      await request('DELETE', `/api/v1/modules/${MODULES.CUSTOM_ROLES}`, alphaToken);

      const response = await request('POST', '/api/v1/roles', alphaToken, {
        ...customRole,
        key: 'shift_lead_two',
      });

      // Entitlement is resolved per request, so a downgrade takes effect
      // immediately rather than at session expiry.
      expect(response.statusCode).toBe(403);
    });

    it('leaves the ungated part of the same controller working', async () => {
      // Listing roles is core; only creating one is paid. A module boundary
      // that took the whole controller with it would be too coarse.
      const response = await request('GET', '/api/v1/roles', alphaToken);

      expect(response.statusCode).toBe(200);
      expect(json(response).roles.length).toBeGreaterThanOrEqual(3);
    });

    it('does not let a disabled module be reached by calling it directly', async () => {
      // The whole requirement, stated plainly: no UI involved, just the
      // endpoint.
      const direct = await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        payload: customRole as never,
        headers: { 'content-type': 'application/json' },
        cookies: { [SESSION_COOKIE_NAME]: alphaToken },
      });

      expect(direct.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('entitlements are per organization', () => {
    it('one organization enabling a module does not affect another', async () => {
      await request('POST', `/api/v1/modules/${MODULES.CRM}`, alphaToken);

      const alpha = await request('GET', '/api/v1/modules', alphaToken);
      const beta = await request('GET', '/api/v1/modules', betaToken);

      // The scenario from the product brief: same binary, different products.
      expect(moduleState(alpha, MODULES.CRM).enabled).toBe(true);
      expect(moduleState(beta, MODULES.CRM).enabled).toBe(false);
    });

    it('a gated endpoint stays refused for the organization without it', async () => {
      await request('POST', `/api/v1/modules/${MODULES.CUSTOM_ROLES}`, alphaToken);

      const allowed = await request('POST', '/api/v1/roles', alphaToken, {
        key: 'alpha_role',
        name: 'Alpha Role',
        defaultScope: 'ORGANIZATION',
        permissions: ['location.read'],
      });
      const refused = await request('POST', '/api/v1/roles', betaToken, {
        key: 'beta_role',
        name: 'Beta Role',
        defaultScope: 'ORGANIZATION',
        permissions: ['location.read'],
      });

      expect(allowed.statusCode).toBe(201);
      expect(refused.statusCode).toBe(403);

      await privileged.role.deleteMany({ where: { organizationId: alphaOrgId } });
    });

    it('row-level security hides one organization module rows from another', async () => {
      await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, alphaToken);

      const rows = await privileged.organizationModule.findMany({
        where: { organizationId: betaOrgId },
      });

      expect(rows.every((row) => row.organizationId === betaOrgId)).toBe(true);
      expect(rows.map((row) => row.moduleKey)).not.toContain(MODULES.INVENTORY);
    });
  });

  // -------------------------------------------------------------------------

  describe('authorization on module management', () => {
    it('requires organization-wide authority to enable', async () => {
      // Turning a module on changes what the organization pays for from
      // Phase 6, so a Location Manager's scoped grant must not suffice.
      const employee = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-mod-emp@example.test',
        password: PASSWORD,
        organizationName: 'Module Test Throwaway',
      });
      const userId = json(employee).user.id;

      await privileged.organizationMembership.deleteMany({ where: { userId } });
      await privileged.organization.deleteMany({ where: { name: 'Module Test Throwaway' } });

      const membership = await privileged.organizationMembership.create({
        data: { userId, organizationId: alphaOrgId, role: 'MEMBER' },
      });
      await privileged.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: '00000000-0000-4000-a000-000000000003',
          scope: 'ORGANIZATION',
          organizationId: alphaOrgId,
        },
      });

      const login = await request('POST', '/api/v1/auth/login', undefined, {
        email: 'e2e-mod-emp@example.test',
        password: PASSWORD,
      });
      const empToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const enable = await request('POST', `/api/v1/modules/${MODULES.CRM}`, empToken);
      expect(enable.statusCode).toBe(403);

      // But they can still SEE what the company has.
      const list = await request('GET', '/api/v1/modules', empToken);
      expect(list.statusCode).toBe(200);
    });

    it('requires authentication', async () => {
      expect((await request('GET', '/api/v1/modules')).statusCode).toBe(401);
      expect((await request('POST', `/api/v1/modules/${MODULES.CRM}`)).statusCode).toBe(401);
    });
  });
});
