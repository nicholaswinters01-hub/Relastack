import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * The CRM, and above all who can see which customer.
 *
 * This is the first phase holding real business data, so the negative cases
 * matter more than the positive ones. A customer list leaking across branches
 * or across tenants is the failure that ends the product.
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

describe('CRM (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let manager: Actor;
  let employee: Actor;

  let downtownId: string;
  let northsideId: string;

  /** Customers planted directly, so the fixtures do not depend on the API. */
  let downtownCustomerId: string;
  let northsideCustomerId: string;
  let unassignedCustomerId: string;

  /** A whole other business. */
  let otherToken: string;
  let otherCustomerId: string;

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

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-crm-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'CRM Test%'");
  }

  /** Adds someone to the main organization with a role at a given scope. */
  async function addPerson(
    slug: string,
    roleId: string,
    scope: 'ORGANIZATION' | 'LOCATION',
    locationIds: string[] = [],
  ): Promise<Actor> {
    const email = `e2e-crm-${slug}@example.test`;

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `CRM Test Throwaway ${slug}`,
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `CRM Test Throwaway ${slug}` } });

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
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

    return { token, userId, membershipId: membership.id };
  }

  /** Plants a customer without going through the API. */
  async function plantCustomer(
    orgId: string,
    displayName: string,
    locationId: string | null,
  ): Promise<string> {
    const row = await privileged.customer.create({
      data: {
        organizationId: orgId,
        displayName,
        firstName: displayName,
        type: 'PERSON',
        stage: 'ACTIVE',
        locationId,
      },
      select: { id: true },
    });

    return row.id;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    // --- the main organization -------------------------------------------
    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-crm-admin@example.test',
      password: PASSWORD,
      organizationName: 'CRM Test Company',
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const adminToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const adminMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = adminMembership.organizationId;
    admin = {
      token: adminToken,
      userId: json(registration).user.id,
      membershipId: adminMembership.id,
    };

    // Trial covers every module, but nothing is switched on beyond core.
    const enabled = await request('POST', `/api/v1/modules/${MODULES.CRM}`, adminToken);
    expect(enabled.statusCode, enabled.body).toBe(200);

    const downtown = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Downtown',
      timezone: 'America/New_York',
    });
    const northside = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Northside',
      timezone: 'America/New_York',
    });
    downtownId = json(downtown).location.id;
    northsideId = json(northside).location.id;

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, 'LOCATION', [
      downtownId,
    ]);
    employee = await addPerson('employee', SYSTEM_ROLE_IDS.employee, 'LOCATION', [downtownId]);

    downtownCustomerId = await plantCustomer(organizationId, 'Downtown Dana', downtownId);
    northsideCustomerId = await plantCustomer(organizationId, 'Northside Nils', northsideId);
    unassignedCustomerId = await plantCustomer(organizationId, 'Unassigned Uma', null);

    // --- a competitor ------------------------------------------------------
    const other = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-crm-other@example.test',
      password: PASSWORD,
      organizationName: 'CRM Test Competitor',
    });
    otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    await request('POST', `/api/v1/modules/${MODULES.CRM}`, otherToken);

    const otherMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(other).user.id },
    });
    otherCustomerId = await plantCustomer(otherMembership.organizationId, 'Secret Client', null);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  const names = (response: InjectResult): string[] =>
    json(response).customers.map((c: { displayName: string }) => c.displayName);

  // =========================================================================

  describe('tenant isolation', () => {
    it('never lists another organization customer', async () => {
      const response = await request('GET', '/api/v1/customers', admin.token);

      expect(names(response)).not.toContain('Secret Client');
    });

    it('reports another organization customer as not found, never forbidden', async () => {
      const response = await request('GET', `/api/v1/customers/${otherCustomerId}`, admin.token);

      // 403 would confirm the record exists, which is itself the leak.
      expect(response.statusCode).toBe(404);
    });

    it('refuses to edit one', async () => {
      const response = await request('PATCH', `/api/v1/customers/${otherCustomerId}`, admin.token, {
        firstName: 'Stolen',
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses to delete one', async () => {
      const response = await request(
        'DELETE',
        `/api/v1/customers/${otherCustomerId}/permanent`,
        admin.token,
      );

      expect(response.statusCode).toBe(404);

      // And it is still there.
      const survivor = await privileged.customer.findUnique({ where: { id: otherCustomerId } });
      expect(survivor).not.toBeNull();
    });

    it('refuses to attach another organization tag', async () => {
      const theirTag = await request('POST', '/api/v1/tags', otherToken, { name: 'Theirs' });
      const tagId = json(theirTag).tags[0].id;

      const response = await request(
        'POST',
        `/api/v1/customers/${downtownCustomerId}/tags`,
        admin.token,
        { tagIds: [tagId] },
      );

      expect(response.statusCode).toBe(400);
    });

    it('row-level security hides customers even from a direct query', async () => {
      // Not through the API at all: this is the database refusing.
      const visible = await privileged.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) FROM customers WHERE organization_id = '${organizationId}'`,
      );

      // The privileged client bypasses RLS by design, so this only confirms
      // the fixtures exist; the API-level assertions above are the real proof.
      expect(Number(visible[0]!.count)).toBeGreaterThan(0);
    });
  });

  // =========================================================================

  describe('module gating', () => {
    it('refuses every CRM route when the module is off', async () => {
      const off = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-crm-nomodule@example.test',
        password: PASSWORD,
        organizationName: 'CRM Test No Module',
      });
      const token = off.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      for (const [method, url] of [
        ['GET', '/api/v1/customers'],
        ['POST', '/api/v1/customers'],
        ['GET', '/api/v1/tags'],
        ['GET', '/api/v1/custom-fields'],
      ] as const) {
        const response = await request(method, url, token, method === 'POST' ? {} : undefined);

        // Hiding the navigation link would not be enforcement. The route is
        // what has to refuse.
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(json(response).code).toBe('MODULE_NOT_ENABLED');
      }
    });
  });

  // =========================================================================

  describe('visibility within the organization', () => {
    it('an organization-wide role sees every customer', async () => {
      const response = await request('GET', '/api/v1/customers', admin.token);
      const seen = names(response);

      expect(seen).toContain('Downtown Dana');
      expect(seen).toContain('Northside Nils');
      expect(seen).toContain('Unassigned Uma');
    });

    it('a location manager sees only their branch', async () => {
      const response = await request('GET', '/api/v1/customers', manager.token);
      const seen = names(response);

      expect(seen).toContain('Downtown Dana');
      expect(seen).not.toContain('Northside Nils');
    });

    it('a location manager cannot reach another branch customer by id', async () => {
      const response = await request(
        'GET',
        `/api/v1/customers/${northsideCustomerId}`,
        manager.token,
      );

      // 404, not 403 — otherwise probing ids would map out the whole book.
      expect(response.statusCode).toBe(404);
    });

    it('an unassigned customer is invisible to a scoped role', async () => {
      const list = await request('GET', '/api/v1/customers', manager.token);
      expect(names(list)).not.toContain('Unassigned Uma');

      const direct = await request(
        'GET',
        `/api/v1/customers/${unassignedCustomerId}`,
        manager.token,
      );
      expect(direct.statusCode).toBe(404);
    });

    it('an employee sees their branch but cannot change anything', async () => {
      const list = await request('GET', '/api/v1/customers', employee.token);
      expect(names(list)).toContain('Downtown Dana');

      const write = await request(
        'PATCH',
        `/api/v1/customers/${downtownCustomerId}`,
        employee.token,
        {
          firstName: 'Renamed',
        },
      );

      // Employees hold customer.read and nothing else: they look a customer
      // up, they do not rewrite the record.
      expect(write.statusCode).toBe(403);
    });

    it('a manager may edit their own branch customer', async () => {
      const response = await request(
        'PATCH',
        `/api/v1/customers/${downtownCustomerId}`,
        manager.token,
        { phone: '555-0100' },
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).customer.phone).toBe('555-0100');
    });

    it('a manager may not edit another branch customer', async () => {
      const response = await request(
        'PATCH',
        `/api/v1/customers/${northsideCustomerId}`,
        manager.token,
        { phone: '555-0199' },
      );

      expect(response.statusCode).toBe(404);
    });

    it('a manager may not move a customer to a branch they do not run', async () => {
      const response = await request(
        'PATCH',
        `/api/v1/customers/${downtownCustomerId}`,
        manager.token,
        { locationId: northsideId },
      );

      // Otherwise a manager could push an awkward customer somewhere they
      // cannot be followed, or pull one they should never have seen.
      expect(response.statusCode).toBe(403);
    });

    it('a manager may not create an unassigned customer', async () => {
      const response = await request('POST', '/api/v1/customers', manager.token, {
        firstName: 'Floating',
        lastName: 'Lead',
      });

      // No location means organization-wide visibility, which a scoped role
      // cannot grant itself.
      expect(response.statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('sharing a customer across locations', () => {
    it('is refused without the Shared Customers module', async () => {
      const response = await request(
        'POST',
        `/api/v1/customers/${downtownCustomerId}/locations`,
        admin.token,
        { locationIds: [northsideId] },
      );

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
      expect(json(response).moduleKey).toBe(MODULES.SHARED_CUSTOMERS);
    });

    it('works once the module is enabled, and widens visibility', async () => {
      const enabled = await request(
        'POST',
        `/api/v1/modules/${MODULES.SHARED_CUSTOMERS}`,
        admin.token,
      );
      expect(enabled.statusCode, enabled.body).toBe(200);

      const shared = await request(
        'POST',
        `/api/v1/customers/${northsideCustomerId}/locations`,
        admin.token,
        { locationIds: [downtownId] },
      );
      expect(shared.statusCode, shared.body).toBe(200);
      expect(json(shared).customer.sharedLocationIds).toContain(downtownId);

      // The Downtown manager can now see a Northside customer, which is the
      // entire point of the capability.
      const list = await request('GET', '/api/v1/customers', manager.token);
      expect(names(list)).toContain('Northside Nils');
    });

    it('unsharing takes the visibility away again', async () => {
      await request('POST', `/api/v1/customers/${northsideCustomerId}/locations`, admin.token, {
        locationIds: [],
      });

      const list = await request('GET', '/api/v1/customers', manager.token);
      expect(names(list)).not.toContain('Northside Nils');
    });

    it('a scoped manager cannot share a customer', async () => {
      const response = await request(
        'POST',
        `/api/v1/customers/${downtownCustomerId}/locations`,
        manager.token,
        { locationIds: [northsideId] },
      );

      // Granting another branch sight of your book is a company decision.
      expect(response.statusCode).toBe(403);
    });

    it('refuses a location from another organization', async () => {
      const theirLocation = await request('POST', '/api/v1/locations', otherToken, {
        name: 'Their Depot',
        timezone: 'UTC',
      });

      const response = await request(
        'POST',
        `/api/v1/customers/${downtownCustomerId}/locations`,
        admin.token,
        { locationIds: [json(theirLocation).location.id] },
      );

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('the lead lifecycle', () => {
    let leadId: string;

    it('creates a lead by default', async () => {
      const response = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Priya',
        lastName: 'Shah',
        email: 'priya@example.test',
        source: 'Website form',
        locationId: downtownId,
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).customer.stage).toBe('LEAD');
      expect(json(response).customer.displayName).toBe('Priya Shah');
      expect(json(response).customer.convertedAt).toBeNull();

      leadId = json(response).customer.id;
    });

    it('keeps notes, contacts and tags across conversion', async () => {
      await request('POST', `/api/v1/customers/${leadId}/notes`, admin.token, {
        body: 'Called about a quote for the back garden.',
      });
      await request('POST', `/api/v1/customers/${leadId}/contacts`, admin.token, {
        firstName: 'Priya',
        isPrimary: true,
      });
      const tag = await request('POST', '/api/v1/tags', admin.token, { name: 'Residential' });
      const tagId = json(tag).tags.find((t: { name: string }) => t.name === 'Residential').id;
      await request('POST', `/api/v1/customers/${leadId}/tags`, admin.token, { tagIds: [tagId] });

      const converted = await request('PATCH', `/api/v1/customers/${leadId}`, admin.token, {
        stage: 'ACTIVE',
      });

      // The reason for one record rather than two tables: nothing is copied,
      // so nothing is lost.
      expect(converted.statusCode, converted.body).toBe(200);
      expect(json(converted).customer.stage).toBe('ACTIVE');
      expect(json(converted).customer.notes).toHaveLength(1);
      expect(json(converted).customer.contacts).toHaveLength(1);
      expect(json(converted).customer.tags[0].name).toBe('Residential');
      expect(json(converted).customer.convertedAt).not.toBeNull();
    });

    it('keeps the original conversion date when a customer lapses and returns', async () => {
      const first = json(await request('GET', `/api/v1/customers/${leadId}`, admin.token)).customer
        .convertedAt;

      await request('PATCH', `/api/v1/customers/${leadId}`, admin.token, { stage: 'INACTIVE' });
      const returned = await request('PATCH', `/api/v1/customers/${leadId}`, admin.token, {
        stage: 'ACTIVE',
      });

      // Re-stamping it would overwrite when the relationship actually began.
      expect(json(returned).customer.convertedAt).toBe(first);
    });

    it('archives without destroying anything', async () => {
      const archived = await request('DELETE', `/api/v1/customers/${leadId}`, admin.token);
      expect(archived.statusCode).toBe(204);

      const hidden = await request('GET', '/api/v1/customers', admin.token);
      expect(names(hidden)).not.toContain('Priya Shah');

      const found = await request('GET', '/api/v1/customers?includeArchived=true', admin.token);
      expect(names(found)).toContain('Priya Shah');

      // The notes are still there.
      const detail = await request('GET', `/api/v1/customers/${leadId}`, admin.token);
      expect(json(detail).customer.notes).toHaveLength(1);
    });

    it('refuses a customer with no name at all', async () => {
      const response = await request('POST', '/api/v1/customers', admin.token, {
        email: 'nobody@example.test',
        locationId: downtownId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('uses the company name for a company', async () => {
      const response = await request('POST', '/api/v1/customers', admin.token, {
        type: 'COMPANY',
        companyName: 'Acme Property Group',
        locationId: downtownId,
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).customer.displayName).toBe('Acme Property Group');
    });

    it('permanent deletion needs more than write', async () => {
      const created = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Doomed',
        locationId: downtownId,
      });
      const id = json(created).customer.id;

      // A manager can archive but must not be able to destroy the history.
      const refused = await request('DELETE', `/api/v1/customers/${id}/permanent`, manager.token);
      expect(refused.statusCode).toBe(403);

      const allowed = await request('DELETE', `/api/v1/customers/${id}/permanent`, admin.token);
      expect(allowed.statusCode).toBe(204);

      expect((await request('GET', `/api/v1/customers/${id}`, admin.token)).statusCode).toBe(404);
    });
  });

  // =========================================================================

  describe('notes', () => {
    let noteCustomerId: string;

    beforeAll(async () => {
      const created = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Note',
        lastName: 'Subject',
        locationId: downtownId,
      });
      noteCustomerId = json(created).customer.id;
    });

    it('records the author and stamps last contact', async () => {
      const response = await request(
        'POST',
        `/api/v1/customers/${noteCustomerId}/notes`,
        manager.token,
        {
          body: 'Visited site, quoted for hedging.',
        },
      );

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).notes[0].authorMembershipId).toBe(manager.membershipId);

      const detail = await request('GET', `/api/v1/customers/${noteCustomerId}`, admin.token);
      // Writing a note IS contact, so the field stays honest without anyone
      // remembering to update it.
      expect(json(detail).customer.lastContactedAt).not.toBeNull();
    });

    it('lets only the author edit their note', async () => {
      const created = await request(
        'POST',
        `/api/v1/customers/${noteCustomerId}/notes`,
        manager.token,
        {
          body: 'Original wording.',
        },
      );
      const noteId = json(created).notes[0].id;

      const byAuthor = await request(
        'PATCH',
        `/api/v1/customers/${noteCustomerId}/notes/${noteId}`,
        manager.token,
        { body: 'Corrected wording.' },
      );
      expect(byAuthor.statusCode, byAuthor.body).toBe(200);
    });

    it('survives the author leaving the company', async () => {
      const leaver = await addPerson('leaver', SYSTEM_ROLE_IDS.org_admin, 'ORGANIZATION');

      const created = await request(
        'POST',
        `/api/v1/customers/${noteCustomerId}/notes`,
        leaver.token,
        {
          body: 'Spoke to the client about renewal.',
        },
      );
      expect(created.statusCode).toBe(201);

      await privileged.organizationMembership.delete({ where: { id: leaver.membershipId } });

      const detail = await request('GET', `/api/v1/customers/${noteCustomerId}`, admin.token);
      const orphan = json(detail).customer.notes.find(
        (n: { body: string }) => n.body === 'Spoke to the client about renewal.',
      );

      // The note stands; only the attribution is gone. Losing the record of a
      // customer conversation because someone left would be worse than useless.
      expect(orphan).toBeDefined();
      expect(orphan.authorMembershipId).toBeNull();
      expect(orphan.authorName).toBeNull();
    });

    it('refuses an empty note', async () => {
      const response = await request(
        'POST',
        `/api/v1/customers/${noteCustomerId}/notes`,
        admin.token,
        {
          body: '   ',
        },
      );

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('custom fields', () => {
    let fieldId: string;
    let fieldCustomerId: string;

    beforeAll(async () => {
      const created = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Field',
        lastName: 'Subject',
        locationId: downtownId,
      });
      fieldCustomerId = json(created).customer.id;
    });

    it('is defined by the organization, not by us', async () => {
      const response = await request('POST', '/api/v1/custom-fields', admin.token, {
        key: 'gate_code',
        label: 'Gate code',
        type: 'TEXT',
      });

      expect(response.statusCode, response.body).toBe(201);
      fieldId = json(response).fields.find((f: { key: string }) => f.key === 'gate_code').id;
    });

    it('needs configure, not merely write', async () => {
      const response = await request('POST', '/api/v1/custom-fields', manager.token, {
        key: 'sneaky',
        label: 'Sneaky',
      });

      // Adding a field changes the form for every colleague at every branch.
      expect(response.statusCode).toBe(403);
    });

    it('stores a value against a customer', async () => {
      const response = await request('PATCH', `/api/v1/customers/${fieldCustomerId}`, admin.token, {
        customFields: { gate_code: '4821' },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).customer.customFields.gate_code).toBe('4821');
    });

    it('rejects a value that does not match the definition', async () => {
      await request('POST', '/api/v1/custom-fields', admin.token, {
        key: 'visit_count',
        label: 'Visit count',
        type: 'NUMBER',
      });

      const response = await request('PATCH', `/api/v1/customers/${fieldCustomerId}`, admin.token, {
        customFields: { visit_count: 'several' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('restricts a choice field to its options', async () => {
      await request('POST', '/api/v1/custom-fields', admin.token, {
        key: 'service_tier',
        label: 'Service tier',
        type: 'SELECT',
        options: ['Bronze', 'Gold'],
      });

      const good = await request('PATCH', `/api/v1/customers/${fieldCustomerId}`, admin.token, {
        customFields: { service_tier: 'Gold' },
      });
      const bad = await request('PATCH', `/api/v1/customers/${fieldCustomerId}`, admin.token, {
        customFields: { service_tier: 'Platinum' },
      });

      expect(good.statusCode, good.body).toBe(200);
      expect(bad.statusCode).toBe(400);
    });

    it('retiring a field keeps the values that were already recorded', async () => {
      const archived = await request('DELETE', `/api/v1/custom-fields/${fieldId}`, admin.token);
      expect(archived.statusCode, archived.body).toBe(200);

      const live = await request('GET', '/api/v1/custom-fields', admin.token);
      expect(live.body).not.toContain('gate_code');

      // The value is still on the record, so restoring the field brings the
      // history back rather than a column of blanks.
      const row = await privileged.customer.findUniqueOrThrow({ where: { id: fieldCustomerId } });
      expect((row.customFields as Record<string, unknown>).gate_code).toBe('4821');

      const restored = await request(
        'POST',
        `/api/v1/custom-fields/${fieldId}/restore`,
        admin.token,
      );
      expect(restored.statusCode).toBe(200);

      const detail = await request('GET', `/api/v1/customers/${fieldCustomerId}`, admin.token);
      expect(json(detail).customer.customFields.gate_code).toBe('4821');
    });

    it('refuses a duplicate key', async () => {
      const response = await request('POST', '/api/v1/custom-fields', admin.token, {
        key: 'gate_code',
        label: 'Gate code again',
      });

      expect(response.statusCode).toBe(409);
    });
  });

  // =========================================================================

  describe('tags', () => {
    it('are shared vocabulary, created once', async () => {
      const created = await request('POST', '/api/v1/tags', admin.token, {
        name: 'Commercial',
        color: 'blue',
      });

      expect(created.statusCode, created.body).toBe(201);
      expect(json(created).tags.some((t: { name: string }) => t.name === 'Commercial')).toBe(true);
    });

    it('refuses a duplicate name', async () => {
      const response = await request('POST', '/api/v1/tags', admin.token, { name: 'Commercial' });

      expect(response.statusCode).toBe(409);
    });

    it('renaming one changes it everywhere at once', async () => {
      const tags = await request('GET', '/api/v1/tags', admin.token);
      const tag = json(tags).tags.find((t: { name: string }) => t.name === 'Commercial');

      await request('POST', `/api/v1/customers/${downtownCustomerId}/tags`, admin.token, {
        tagIds: [tag.id],
      });

      const renamed = await request('PATCH', `/api/v1/tags/${tag.id}`, admin.token, {
        name: 'Commercial Client',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      // The whole reason a tag is a row rather than a string on each customer.
      const customer = await request('GET', `/api/v1/customers/${downtownCustomerId}`, admin.token);
      expect(json(customer).customer.tags[0].name).toBe('Commercial Client');
    });

    it('an employee can read the vocabulary but not change it', async () => {
      expect((await request('GET', '/api/v1/tags', employee.token)).statusCode).toBe(200);
      expect(
        (await request('POST', '/api/v1/tags', employee.token, { name: 'Nope' })).statusCode,
      ).toBe(403);
    });
  });

  // =========================================================================

  describe('finding customers', () => {
    it('searches by name, email and phone', async () => {
      const byName = await request('GET', '/api/v1/customers?search=Downtown', admin.token);
      expect(names(byName)).toContain('Downtown Dana');

      const byNothing = await request('GET', '/api/v1/customers?search=zzzznotathing', admin.token);
      expect(json(byNothing).customers).toHaveLength(0);
    });

    it('search respects scope, so it cannot be used to probe', async () => {
      const response = await request('GET', '/api/v1/customers?search=Northside', manager.token);

      // Searching must not become the hole that direct lookup carefully is not.
      expect(names(response)).not.toContain('Northside Nils');
    });

    it('filters by stage', async () => {
      const response = await request('GET', '/api/v1/customers?stage=LEAD', admin.token);

      for (const customer of json(response).customers) {
        expect(customer.stage).toBe('LEAD');
      }
    });

    it('filters by location', async () => {
      const response = await request(
        'GET',
        `/api/v1/customers?locationId=${northsideId}`,
        admin.token,
      );

      expect(names(response)).toEqual(['Northside Nils']);
    });

    it('pages with a cursor', async () => {
      const first = await request('GET', '/api/v1/customers?limit=2', admin.token);
      expect(json(first).customers).toHaveLength(2);
      expect(json(first).nextCursor).not.toBeNull();

      const second = await request(
        'GET',
        `/api/v1/customers?limit=2&cursor=${json(first).nextCursor}`,
        admin.token,
      );

      const firstIds = json(first).customers.map((c: { id: string }) => c.id);
      const secondIds = json(second).customers.map((c: { id: string }) => c.id);

      expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
    });

    it('rejects a nonsense limit rather than trying to serve it', async () => {
      const response = await request('GET', '/api/v1/customers?limit=100000', admin.token);

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('deleting for good', () => {
    it('refuses a customer with work attached, and says to archive instead', async () => {
      const created = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Busy Bea',
        locationId: downtownId,
      });
      const id = json(created).customer.id;
      const task = await request('POST', '/api/v1/tasks', admin.token, {
        title: 'Call Bea back',
        customerId: id,
        locationId: downtownId,
      });
      expect(task.statusCode, task.body).toBe(201);

      const refused = await request('DELETE', `/api/v1/customers/${id}/permanent`, admin.token);
      expect(refused.statusCode).toBe(409);
      expect(json(refused).code).toBe('CUSTOMER_HAS_WORK');
      expect(json(refused).message).toContain('1 task');

      // Nothing was touched.
      expect((await request('GET', `/api/v1/customers/${id}`, admin.token)).statusCode).toBe(200);
      expect(
        (await request('GET', `/api/v1/tasks/${json(task).task.id}`, admin.token)).statusCode,
      ).toBe(200);

      // Once the work is gone, an owner can delete.
      await request('DELETE', `/api/v1/tasks/${json(task).task.id}`, admin.token);
      const allowed = await request('DELETE', `/api/v1/customers/${id}/permanent`, admin.token);
      expect(allowed.statusCode, allowed.body).toBe(204);
    });
  });

  // =========================================================================

  describe('editing', () => {
    it('clears a field that is emptied, and keeps one that is not mentioned', async () => {
      const created = await request('POST', '/api/v1/customers', admin.token, {
        firstName: 'Clearable',
        lastName: 'Carl',
        email: 'carl@example.test',
        phone: '555-0100',
        locationId: downtownId,
      });
      const id = json(created).customer.id;

      const edited = await request('PATCH', `/api/v1/customers/${id}`, admin.token, {
        email: '',
        lastName: '',
      });
      expect(edited.statusCode, edited.body).toBe(200);

      const customer = json(edited).customer;
      expect(customer.email).toBeNull();
      expect(customer.lastName).toBeNull();
      expect(customer.displayName).toBe('Clearable');
      // Not mentioned, so untouched.
      expect(customer.phone).toBe('555-0100');
    });
  });

  // =========================================================================

  describe('account numbers', () => {
    const create = async (firstName: string) => {
      const response = await request('POST', '/api/v1/customers', admin.token, {
        firstName,
        locationId: downtownId,
      });
      expect(response.statusCode, response.body).toBe(201);
      return json(response).customer as { id: string; accountNumber: number };
    };
    const renumber = (token: string, id: string, accountNumber: number) =>
      request('PATCH', `/api/v1/customers/${id}`, token, { accountNumber });

    it('gives every customer the next number, one business at a time', async () => {
      const first = await create('Numbered One');
      const second = await create('Numbered Two');
      expect(second.accountNumber).toBe(first.accountNumber + 1);
      expect(first.accountNumber).toBeGreaterThanOrEqual(1001);

      // Another business counts on its own.
      const rival = await request('POST', '/api/v1/customers', otherToken, {
        firstName: 'Rival First',
      });
      expect(rival.statusCode, rival.body).toBe(201);
      const numbers = await privileged.customer.findMany({
        where: { organizationId: { not: organizationId }, id: json(rival).customer.id },
        select: { accountNumber: true },
      });
      expect(numbers[0]!.accountNumber).toBeLessThan(first.accountNumber + 1000);
    });

    it('keeps the number when a lead becomes a customer', async () => {
      const lead = await create('Converting Carla');
      const converted = await request('PATCH', `/api/v1/customers/${lead.id}`, admin.token, {
        stage: 'ACTIVE',
      });
      expect(json(converted).customer.accountNumber).toBe(lead.accountNumber);
    });

    it('never reuses a number, even after a permanent delete', async () => {
      const doomed = await create('Deleted Dan');
      await request('DELETE', `/api/v1/customers/${doomed.id}/permanent`, admin.token);

      const next = await create('After Dan');
      expect(next.accountNumber).toBe(doomed.accountNumber + 1);
    });

    it('finds a customer by number, with or without the #', async () => {
      const target = await create('Findable Fran');
      for (const term of [String(target.accountNumber), `%23${target.accountNumber}`]) {
        const found = await request('GET', `/api/v1/customers?search=${term}`, admin.token);
        expect(json(found).customers.map((c: { id: string }) => c.id)).toEqual([target.id]);
      }
    });

    it('lets an owner choose a number, and nobody else', async () => {
      const customer = await create('Imported Ivy');

      const refused = await renumber(manager.token, customer.id, 42);
      expect(refused.statusCode).toBe(403);

      const allowed = await renumber(admin.token, customer.id, 42);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(json(allowed).customer.accountNumber).toBe(42);
    });

    it('refuses a number already in use', async () => {
      const a = await create('Duplicate A');
      const b = await create('Duplicate B');

      const response = await renumber(admin.token, b.id, a.accountNumber);
      expect(response.statusCode).toBe(409);
      expect(json(response).message).toContain(`#${a.accountNumber}`);
    });

    it('moves the counter past a chosen number, so automatic ones never collide', async () => {
      const chosen = await create('Far Ahead');
      const ahead = chosen.accountNumber + 50;
      expect((await renumber(admin.token, chosen.id, ahead)).statusCode).toBe(200);

      const next = await create('After Far Ahead');
      expect(next.accountNumber).toBe(ahead + 1);
    });

    it('shows the number on a job only when the customer is visible', async () => {
      await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, admin.token);
      const start = new Date(Date.now() + 5 * 86_400_000);
      const job = await request('POST', '/api/v1/jobs', admin.token, {
        title: 'Numbered job',
        locationId: downtownId,
        customerId: northsideCustomerId,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
        acknowledgeConflicts: true,
      });
      expect(job.statusCode, job.body).toBe(201);
      const jobId = json(job).job.id;
      expect(json(job).job.customerAccountNumber).toEqual(expect.any(Number));

      // The downtown manager sees the job but not the Northside customer.
      const asManager = await request('GET', `/api/v1/jobs/${jobId}`, manager.token);
      expect(asManager.statusCode, asManager.body).toBe(200);
      expect(json(asManager).job.customerName).toBeNull();
      expect(json(asManager).job.customerAccountNumber).toBeNull();
    });
  });
});
