import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { createPrismaClient, type PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * TENANT ISOLATION.
 *
 * The central promise of the product: one company can never see another's
 * data. This suite is the proof, and it runs on every commit forever.
 *
 * Two companies are created through the real registration endpoint, then every
 * reachable path is tried from one against the other.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Company {
  token: string;
  organizationId: string;
  userId: string;
  email: string;
}

describe('Tenant isolation (e2e)', () => {
  let app: NestFastifyApplication;
  /** Bypasses RLS. Fixtures only — never used to assert what a tenant can see. */
  let privileged: PrismaClient;
  let alpha: Company;
  let beta: Company;

  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      // Fastify does not infer a content-type for every method, and without one
      // the body arrives unparsed as a string.
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  async function registerCompany(slugPart: string, orgName: string): Promise<Company> {
    const email = `e2e-iso-${slugPart}@example.test`;

    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: orgName,
    });

    expect(response.statusCode, response.body).toBe(201);

    const token = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const userId = JSON.parse(response.body).user.id;

    const current = await request('GET', '/api/v1/organizations/current', token);
    expect(current.statusCode).toBe(200);

    return {
      token,
      userId,
      email,
      organizationId: JSON.parse(current.body).organization.id,
    };
  }

  async function cleanUp(): Promise<void> {
    // Runs as the migration role, which bypasses RLS — the only correct way to
    // clean up across tenants.
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-iso-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      `DELETE FROM organizations WHERE name IN (
         'Alpha Landscaping', 'Alpha Landscaping Renamed', 'Beta HVAC',
         'Identical Name Co', 'Orphan Test Co', 'Suspended Test Co'
       )`,
    );
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    alpha = await registerCompany('alpha', 'Alpha Landscaping');
    beta = await registerCompany('beta', 'Beta HVAC');

    expect(alpha.organizationId).not.toBe(beta.organizationId);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('the database itself enforces isolation', () => {
    /**
     * THE META-TEST.
     *
     * Everything else in this file would still pass if row-level security were
     * completely inert, because the application layer also filters. This test
     * exists to prove the database layer is genuinely enforcing — that if
     * application code were wrong tomorrow, the data would still be safe.
     *
     * It connects as the unprivileged application role and issues raw SQL with
     * no WHERE clause at all. Anything it can see, a buggy query could see.
     */
    let appRoleClient: PrismaClient;

    beforeAll(() => {
      const appUrl = process.env.DATABASE_URL_APP;
      expect(
        appUrl,
        'DATABASE_URL_APP must be configured, or RLS is not being exercised at all',
      ).toBeDefined();

      // Quiet: this suite provokes RLS rejections on purpose and asserts them.
      appRoleClient = createPrismaClient({ databaseUrl: appUrl!, logErrors: false });
    });

    afterAll(async () => {
      await appRoleClient?.$disconnect();
    });

    it('the application role is not a superuser and cannot bypass RLS', async () => {
      // If either flag were true, every policy in this database would be
      // decoration and every other test here would be false confidence.
      const [role] = await appRoleClient.$queryRawUnsafe<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');

      expect(role?.rolsuper).toBe(false);
      expect(role?.rolbypassrls).toBe(false);
    });

    it('row-level security is enabled AND forced on tenant-owned tables', async () => {
      // ENABLE alone still exempts the table owner. FORCE closes that.
      const rows = await appRoleClient.$queryRawUnsafe<
        Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(
        // relname is Postgres's internal `name` type, which the pg adapter
        // cannot read back without a cast.
        `SELECT relname::text AS relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname IN ('organizations','organization_memberships')`,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
      }
    });

    it('an unscoped SELECT returns nothing when no tenant context is set', async () => {
      const rows = await appRoleClient.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM organizations',
      );

      // Failing closed is the point: forgetting to establish context must deny
      // access, never grant it.
      expect(rows).toHaveLength(0);
    });

    it('an unscoped SELECT under one tenant cannot see the other', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_organization_id = '${alpha.organizationId}'`,
        );
        // Deliberately no WHERE clause — this is the forgotten-predicate bug,
        // reproduced on purpose.
        return tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          'SELECT id, name FROM organizations',
        );
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(alpha.organizationId);
      expect(rows.map((r) => r.id)).not.toContain(beta.organizationId);
    });

    it('membership rows are invisible across tenants even without a WHERE clause', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_organization_id = '${alpha.organizationId}'`,
        );
        return tx.$queryRawUnsafe<Array<{ organization_id: string }>>(
          'SELECT organization_id FROM organization_memberships',
        );
      });

      expect(rows.every((r) => r.organization_id === alpha.organizationId)).toBe(true);
      expect(rows.map((r) => r.organization_id)).not.toContain(beta.organizationId);
    });

    it('refuses to write a row into another tenant', async () => {
      // WITH CHECK is narrower than USING: you may only write into the
      // organization currently in context.
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_organization_id = '${alpha.organizationId}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO organization_memberships (id, user_id, organization_id, role, created_at, updated_at)
             VALUES (gen_random_uuid(), '${alpha.userId}', '${beta.organizationId}', 'OWNER', now(), now())`,
          );
        }),
      ).rejects.toThrow();
    });

    it('cannot update another tenant even with an explicit id', async () => {
      await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_organization_id = '${alpha.organizationId}'`,
        );
        const affected = await tx.$executeRawUnsafe(
          `UPDATE organizations SET name = 'HIJACKED' WHERE id = '${beta.organizationId}'`,
        );
        // Zero rows affected: the row is not merely protected, it is invisible.
        expect(affected).toBe(0);
      });

      const beta_ = await privileged.organization.findUnique({
        where: { id: beta.organizationId },
      });
      expect(beta_?.name).toBe('Beta HVAC');
    });

    it('cannot delete another tenant', async () => {
      await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_organization_id = '${alpha.organizationId}'`,
        );
        const affected = await tx.$executeRawUnsafe(
          `DELETE FROM organizations WHERE id = '${beta.organizationId}'`,
        );
        expect(affected).toBe(0);
      });

      const stillThere = await privileged.organization.findUnique({
        where: { id: beta.organizationId },
      });
      expect(stillThere).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('the API enforces isolation', () => {
    it('each company sees its own organization', async () => {
      const a = await request('GET', '/api/v1/organizations/current', alpha.token);
      const b = await request('GET', '/api/v1/organizations/current', beta.token);

      expect(JSON.parse(a.body).organization.name).toBe('Alpha Landscaping');
      expect(JSON.parse(b.body).organization.name).toBe('Beta HVAC');
    });

    it('returns 404 — never 403 — for another company by id', async () => {
      const response = await request(
        'GET',
        `/api/v1/organizations/${beta.organizationId}`,
        alpha.token,
      );

      // 403 would confirm the record exists, which is itself a cross-tenant
      // leak: an attacker enumerating ids would learn what other companies own.
      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(403);
    });

    it('makes another company indistinguishable from one that does not exist', async () => {
      const other = await request(
        'GET',
        `/api/v1/organizations/${beta.organizationId}`,
        alpha.token,
      );
      const nonexistent = await request(
        'GET',
        '/api/v1/organizations/00000000-0000-4000-8000-000000000000',
        alpha.token,
      );

      expect(other.statusCode).toBe(nonexistent.statusCode);
      expect(JSON.parse(other.body).message).toBe(JSON.parse(nonexistent.body).message);
    });

    it('works in the other direction too', async () => {
      const response = await request(
        'GET',
        `/api/v1/organizations/${alpha.organizationId}`,
        beta.token,
      );

      expect(response.statusCode).toBe(404);
    });

    it('a company can fetch itself by its own id', async () => {
      const response = await request(
        'GET',
        `/api/v1/organizations/${alpha.organizationId}`,
        alpha.token,
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).organization.id).toBe(alpha.organizationId);
    });

    it('member listings never include another company', async () => {
      const a = await request('GET', '/api/v1/organizations/current/members', alpha.token);
      const b = await request('GET', '/api/v1/organizations/current/members', beta.token);

      const aEmails = JSON.parse(a.body).members.map((m: { email: string }) => m.email);
      const bEmails = JSON.parse(b.body).members.map((m: { email: string }) => m.email);

      expect(aEmails).toEqual([alpha.email]);
      expect(bEmails).toEqual([beta.email]);
      expect(aEmails).not.toContain(beta.email);
    });

    it('renaming one company leaves the other untouched', async () => {
      const response = await request('PATCH', '/api/v1/organizations/current', alpha.token, {
        name: 'Alpha Landscaping Renamed',
      });

      expect(response.statusCode, response.body).toBe(200);

      const b = await request('GET', '/api/v1/organizations/current', beta.token);
      expect(JSON.parse(b.body).organization.name).toBe('Beta HVAC');

      // Restore, so later assertions in this file are order-independent.
      await request('PATCH', '/api/v1/organizations/current', alpha.token, {
        name: 'Alpha Landscaping',
      });
    });

    it('rejects business endpoints without authentication', async () => {
      expect((await request('GET', '/api/v1/organizations/current')).statusCode).toBe(401);
      expect((await request('GET', '/api/v1/organizations/current/members')).statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------

  describe('registration and ownership', () => {
    it('makes the registrant the owner of a new organization', async () => {
      const response = await request('GET', '/api/v1/organizations/current', alpha.token);

      expect(JSON.parse(response.body).roles).toContain('org_admin');
    });

    it('gives each company a distinct slug', async () => {
      const rows = await privileged.organization.findMany({
        where: { name: { in: ['Alpha Landscaping', 'Beta HVAC'] } },
      });

      const slugs = rows.map((r) => r.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs.every((s) => /^[a-z0-9-]+$/.test(s))).toBe(true);
    });

    it('two companies registering the same name still get unique slugs', async () => {
      const first = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-iso-same1@example.test',
        password: PASSWORD,
        organizationName: 'Identical Name Co',
      });
      const second = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-iso-same2@example.test',
        password: PASSWORD,
        organizationName: 'Identical Name Co',
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);

      const rows = await privileged.organization.findMany({
        where: { name: 'Identical Name Co' },
      });

      expect(rows).toHaveLength(2);
      expect(rows[0]?.slug).not.toBe(rows[1]?.slug);

      await privileged.$executeRawUnsafe(
        "DELETE FROM organizations WHERE name = 'Identical Name Co'",
      );
    });

    it('requires an organization name', async () => {
      const response = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-iso-noorg@example.test',
        password: PASSWORD,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------

  describe('users without an organization', () => {
    it('can still see who they are and sign out, but reach no business data', async () => {
      const registration = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-iso-orphan@example.test',
        password: PASSWORD,
        organizationName: 'Orphan Test Co',
      });
      const token = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      // Simulate an employee being removed from the business.
      await privileged.$executeRawUnsafe(
        `DELETE FROM organization_memberships WHERE user_id =
           (SELECT id FROM users WHERE email = 'e2e-iso-orphan@example.test')`,
      );

      // Identity endpoints keep working — otherwise they would be trapped,
      // unable to even sign out.
      expect((await request('GET', '/api/v1/auth/me', token)).statusCode).toBe(200);

      // Business endpoints do not.
      expect((await request('GET', '/api/v1/organizations/current', token)).statusCode).toBe(403);

      expect((await request('POST', '/api/v1/auth/logout', token)).statusCode).toBe(200);

      await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name = 'Orphan Test Co'");
    });

    it('locks out a member of a suspended organization', async () => {
      const registration = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-iso-susp@example.test',
        password: PASSWORD,
        organizationName: 'Suspended Test Co',
      });
      const token = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      expect((await request('GET', '/api/v1/organizations/current', token)).statusCode).toBe(200);

      await privileged.$executeRawUnsafe(
        "UPDATE organizations SET status = 'SUSPENDED' WHERE name = 'Suspended Test Co'",
      );

      // A suspended business cannot act, however valid its members' sessions.
      // This is what makes non-payment enforceable in Phase 6.
      expect((await request('GET', '/api/v1/organizations/current', token)).statusCode).toBe(403);

      await privileged.$executeRawUnsafe(
        "DELETE FROM organizations WHERE name = 'Suspended Test Co'",
      );
    });
  });
});
