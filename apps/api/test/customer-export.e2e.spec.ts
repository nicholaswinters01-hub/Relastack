import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Customer export.
 *
 *   - exporting is its own permission: a manager may, an employee may not
 *   - the file holds exactly the customers the export permission reaches
 *   - contacts and notes follow their customer
 *   - a read-only business can still leave with its records
 *   - a cell cannot smuggle a formula into a spreadsheet
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

describe('Customer export (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let downtownManager: Actor;
  let employee: Actor;

  let downtownId: string;
  let northsideId: string;

  let otherToken: string;

  const request = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (response: InjectResult) => JSON.parse(response.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  const exported = async (token: string, kind: string) => {
    const response = await request('GET', `/api/v1/customers/export/${kind}`, token);
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-export-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Export Test%'");
  }

  async function register(slug: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-export-${slug}@example.test`,
      password: PASSWORD,
      organizationName,
      firstName: slug,
    });
    return { token: tokenOf(response), userId: json(response).user.id as string };
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const { userId } = await register(slug, `Export Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Export Test Throwaway ${slug}` } });
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
      email: `e2e-export-${slug}@example.test`,
      password: PASSWORD,
    });
    return { token: tokenOf(login), membershipId: membership.id };
  }

  const location = async (name: string) =>
    json(
      await request('POST', '/api/v1/locations', admin.token, {
        name,
        timezone: 'America/New_York',
      }),
    ).location.id as string;

  const customer = (displayName: string, locationId: string | null, data = {}) =>
    privileged.customer.create({ data: { organizationId, displayName, locationId, ...data } });

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const owner = await register('admin', 'Export Test Company');
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: owner.userId },
    });
    organizationId = membership.organizationId;
    admin = { token: owner.token, membershipId: membership.id };
    const crm = await request('POST', `/api/v1/modules/${MODULES.CRM}`, admin.token);
    expect(crm.statusCode, crm.body).toBeLessThan(300);

    downtownId = await location('Downtown');
    northsideId = await location('Northside');
    downtownManager = await addPerson('dtmanager', SYSTEM_ROLE_IDS.location_manager, [downtownId]);
    employee = await addPerson('employee', SYSTEM_ROLE_IDS.employee, [downtownId]);

    await privileged.customFieldDefinition.create({
      data: { organizationId, key: 'gate_code', label: 'Gate code' },
    });
    const tag = await privileged.tag.create({ data: { organizationId, name: 'VIP' } });

    const downtown = await customer('Downtown Dental', downtownId, {
      email: 'front@dental.example',
      addressLine1: '1 Main St, Suite 2',
      customFields: { gate_code: '4412' },
      ownerMembershipId: downtownManager.membershipId,
      stage: 'ACTIVE',
    });
    await privileged.customerTag.create({
      data: { customerId: downtown.id, tagId: tag.id, organizationId },
    });
    await privileged.contact.create({
      data: { organizationId, customerId: downtown.id, firstName: 'Dana', isPrimary: true },
    });
    await privileged.customerNote.create({
      data: { organizationId, customerId: downtown.id, body: 'Prefers mornings, "no" dogs' },
    });

    const north = await customer('Northside Bakery', northsideId);
    await privileged.contact.create({
      data: { organizationId, customerId: north.id, firstName: 'Nora' },
    });
    await privileged.customerNote.create({
      data: { organizationId, customerId: north.id, body: 'North note' },
    });

    // Shared with Downtown: the Downtown manager may see it, so may export it.
    const shared = await customer('Shared Gym', northsideId);
    await privileged.customerLocation.create({
      data: { customerId: shared.id, locationId: downtownId, organizationId },
    });

    await customer('Unassigned Lead', null);
    await customer('=HYPERLINK("http://evil.example","click")', downtownId);

    otherToken = (await register('other', 'Export Test Competitor')).token;
    await request('POST', `/api/v1/modules/${MODULES.CRM}`, otherToken);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  it('gives an owner every customer, with tags, custom fields and the owner', async () => {
    const response = await exported(admin.token, 'customers');
    expect(response.headers['content-disposition']).toContain('filename="customers.csv"');
    expect(response.body.charCodeAt(0)).toBe(0xfeff);
    const [header, ...rows] = response.body.slice(1).trim().split('\r\n');
    expect(header).toContain('Account number,Display name');
    expect(header!.endsWith(',Gate code')).toBe(true);
    expect(rows).toHaveLength(5);

    const dental = rows.find((row) => row.includes('Downtown Dental'))!;
    expect(dental).toContain('"1 Main St, Suite 2"');
    expect(dental).toContain('front@dental.example');
    expect(dental).toContain(',Downtown,dtmanager,VIP,');
    expect(dental.endsWith(',4412')).toBe(true);
    expect(response.body).toContain('Unassigned Lead');
  });

  it('defuses a customer name that is really a formula', async () => {
    const { body } = await exported(admin.token, 'customers');
    expect(body).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(body).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('gives a branch manager only the customers their export reaches', async () => {
    const { body } = await exported(downtownManager.token, 'customers');
    expect(body).toContain('Downtown Dental');
    expect(body).toContain('Shared Gym');
    expect(body).not.toContain('Northside Bakery');
    expect(body).not.toContain('Unassigned Lead');
  });

  it('exports only where export is held, not everywhere the reader can read', async () => {
    // Manages Downtown; works at Northside as an employee, so reads customers
    // there but may not export them.
    const both = await addPerson('split', SYSTEM_ROLE_IDS.location_manager, [downtownId]);
    const extra = await privileged.membershipRole.create({
      data: {
        membershipId: both.membershipId,
        roleId: SYSTEM_ROLE_IDS.employee,
        scope: 'LOCATION',
        organizationId,
      },
    });
    await privileged.membershipRoleLocation.create({
      data: { membershipRoleId: extra.id, locationId: northsideId, organizationId },
    });

    const list = json(await request('GET', '/api/v1/customers?limit=100', both.token));
    expect(JSON.stringify(list)).toContain('Northside Bakery');

    const { body } = await exported(both.token, 'customers');
    expect(body).toContain('Downtown Dental');
    expect(body).not.toContain('Northside Bakery');
  });

  it('keeps contacts and notes to the customers the export reaches', async () => {
    const contacts = (await exported(downtownManager.token, 'contacts')).body;
    expect(contacts).toContain('Dana');
    expect(contacts).not.toContain('Nora');

    const notes = (await exported(downtownManager.token, 'notes')).body;
    expect(notes).toContain('"Prefers mornings, ""no"" dogs"');
    expect(notes).not.toContain('North note');

    const everything = (await exported(admin.token, 'notes')).body;
    expect(everything).toContain('North note');
  });

  it('refuses an employee, who can read customers but not take them all', async () => {
    const list = await request('GET', '/api/v1/customers', employee.token);
    expect(list.statusCode, list.body).toBe(200);
    for (const kind of ['customers', 'contacts', 'notes']) {
      const response = await request('GET', `/api/v1/customers/export/${kind}`, employee.token);
      expect(response.statusCode).toBe(403);
    }
  });

  it('refuses an export it does not know', async () => {
    const response = await request('GET', '/api/v1/customers/export/passwords', admin.token);
    expect(response.statusCode).toBe(400);
  });

  it('still lets a read-only business leave with its records', async () => {
    const before = await privileged.subscription.findFirstOrThrow({ where: { organizationId } });
    await privileged.subscription.update({
      where: { id: before.id },
      data: { status: 'SUSPENDED' },
    });
    try {
      // Proves the business really is read-only: a write is refused.
      const write = await request('POST', '/api/v1/customers', admin.token, {
        type: 'PERSON',
        firstName: 'Blocked',
      });
      expect(write.statusCode).toBe(403);
      const { body } = await exported(admin.token, 'customers');
      expect(body).toContain('Downtown Dental');
    } finally {
      await privileged.subscription.update({
        where: { id: before.id },
        data: { status: before.status },
      });
    }
  });

  it('shows another business none of these customers', async () => {
    const { body } = await exported(otherToken, 'customers');
    expect(body).not.toContain('Downtown Dental');
    expect(body.slice(1).trim().split('\r\n')).toHaveLength(1);
  });
});
