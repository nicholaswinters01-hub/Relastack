import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Invitations.
 *
 * How employees get into an organization. Self-registration always creates a
 * NEW business, so this is the only path by which someone joins an existing
 * one — which makes it a boundary worth testing hard.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Invitations (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let adminToken: string;
  let downtownId: string;
  let warehouseId: string;

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
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

  /** Extract the one-time token from the returned accept link. */
  const tokenFrom = (response: InjectResult) =>
    new URL(json(response).acceptUrl).searchParams.get('token')!;

  async function invite(email: string, overrides: Record<string, unknown> = {}) {
    return request('POST', '/api/v1/invitations', adminToken, {
      email,
      roleKey: 'employee',
      scope: 'ORGANIZATION',
      locationIds: [],
      ...overrides,
    });
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-inv-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Invite %'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-inv-admin@example.test',
      password: PASSWORD,
      organizationName: 'Invite Test Company',
    });
    expect(registration.statusCode, registration.body).toBe(201);

    adminToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = membership.organizationId;

    const make = async (name: string) => {
      const response = await request('POST', '/api/v1/locations', adminToken, {
        name,
        timezone: 'UTC',
      });
      return json(response).location.id as string;
    };

    downtownId = await make('Downtown');
    warehouseId = await make('Warehouse');
  });

  beforeEach(async () => {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-inv-invitee%@example.test'",
    );
    await privileged.invitation.deleteMany({ where: { organizationId } });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('creating an invitation', () => {
    it('returns the accept link exactly once', async () => {
      const response = await invite('e2e-inv-invitee@example.test');

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).acceptUrl).toContain('/invitations/accept?token=');
      expect(json(response).invitation.status).toBe('PENDING');
    });

    it('stores only the hash of the token', async () => {
      const response = await invite('e2e-inv-invitee@example.test');
      const token = tokenFrom(response);

      const row = await privileged.invitation.findFirstOrThrow({ where: { organizationId } });

      // Same treatment as a session token: the link grants access to a
      // company's data, so a stolen database must not yield a working one.
      expect(row.tokenHash).not.toBe(token);
      expect(row.tokenHash).toHaveLength(64);
    });

    it('never returns the token in the listing', async () => {
      await invite('e2e-inv-invitee@example.test');

      const list = await request('GET', '/api/v1/invitations', adminToken);

      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain('token');
      expect(json(list).invitations).toHaveLength(1);
    });

    it('supersedes a previous pending invitation to the same address', async () => {
      const first = await invite('e2e-inv-invitee@example.test');
      const second = await invite('e2e-inv-invitee@example.test');

      // "Invite again" should replace, not duplicate.
      const pending = await request('GET', '/api/v1/invitations', adminToken);
      expect(json(pending).invitations).toHaveLength(1);

      // And the superseded link must stop working.
      const stale = await request('GET', `/api/v1/invitations/preview?token=${tokenFrom(first)}`);
      expect(stale.statusCode).toBe(404);

      const fresh = await request('GET', `/api/v1/invitations/preview?token=${tokenFrom(second)}`);
      expect(fresh.statusCode).toBe(200);
    });

    it('refuses to invite someone already in the organization', async () => {
      const response = await invite('e2e-inv-admin@example.test');

      expect(response.statusCode).toBe(409);
    });

    it('rejects a location-scoped invitation with no locations', async () => {
      const response = await invite('e2e-inv-invitee@example.test', {
        scope: 'LOCATION',
        locationIds: [],
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an organization-scoped invitation that names locations', async () => {
      const response = await invite('e2e-inv-invitee@example.test', {
        scope: 'ORGANIZATION',
        locationIds: [downtownId],
      });

      // Ignoring them silently would make the request appear to do something
      // it did not.
      expect(response.statusCode).toBe(400);
    });

    it('rejects a location from another organization', async () => {
      const other = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-inv-other@example.test',
        password: PASSWORD,
        organizationName: 'Invite Other Company',
      });
      const otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
      const otherLocation = await request('POST', '/api/v1/locations', otherToken, {
        name: 'Their Branch',
        timezone: 'UTC',
      });

      const response = await invite('e2e-inv-invitee@example.test', {
        scope: 'LOCATION',
        locationIds: [json(otherLocation).location.id],
      });

      // Their location is invisible under our tenant context, so it simply is
      // not found — there is no code path that could accept it.
      expect(response.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const response = await request('POST', '/api/v1/invitations', undefined, {
        email: 'e2e-inv-invitee@example.test',
        roleKey: 'employee',
        scope: 'ORGANIZATION',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------

  describe('previewing', () => {
    it('shows the organization and role without an account', async () => {
      const created = await invite('e2e-inv-invitee@example.test');

      const preview = await request(
        'GET',
        `/api/v1/invitations/preview?token=${tokenFrom(created)}`,
      );

      expect(preview.statusCode).toBe(200);
      expect(json(preview).organizationName).toBe('Invite Test Company');
      expect(json(preview).roleName).toBe('Employee');
      expect(json(preview).requiresAccount).toBe(true);
    });

    it('rejects an unknown token', async () => {
      const response = await request('GET', '/api/v1/invitations/preview?token=not-a-real-token');

      expect(response.statusCode).toBe(404);
    });

    it('rejects a revoked invitation', async () => {
      const created = await invite('e2e-inv-invitee@example.test');
      await request('DELETE', `/api/v1/invitations/${json(created).invitation.id}`, adminToken);

      const response = await request(
        'GET',
        `/api/v1/invitations/preview?token=${tokenFrom(created)}`,
      );

      expect(response.statusCode).toBe(404);
    });

    it('rejects an expired invitation', async () => {
      const created = await invite('e2e-inv-invitee@example.test');
      await privileged.invitation.updateMany({
        where: { organizationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(
        'GET',
        `/api/v1/invitations/preview?token=${tokenFrom(created)}`,
      );

      expect(response.statusCode).toBe(404);
    });

    it('gives the same answer for unknown, revoked and expired', async () => {
      const created = await invite('e2e-inv-invitee@example.test');
      await request('DELETE', `/api/v1/invitations/${json(created).invitation.id}`, adminToken);

      const revoked = await request(
        'GET',
        `/api/v1/invitations/preview?token=${tokenFrom(created)}`,
      );
      const unknown = await request('GET', '/api/v1/invitations/preview?token=made-up');

      // Distinguishing them would let anyone holding a malformed link probe
      // which tokens once existed.
      expect(revoked.statusCode).toBe(unknown.statusCode);
      expect(json(revoked).message).toBe(json(unknown).message);
    });
  });

  // -------------------------------------------------------------------------

  describe('accepting', () => {
    it('creates the account, grants the role, and signs them in', async () => {
      const created = await invite('e2e-inv-invitee@example.test');

      const response = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
        password: PASSWORD,
        firstName: 'New',
        lastName: 'Hire',
      });

      expect(response.statusCode, response.body).toBe(200);

      const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();

      // Signed in and already inside the organization.
      const org = await request('GET', '/api/v1/organizations/current', cookie!.value);
      expect(org.statusCode).toBe(200);
      expect(json(org).organization.name).toBe('Invite Test Company');
      expect(json(org).roles).toContain('employee');
    });

    it('marks the invitation used so the link cannot be replayed', async () => {
      const created = await invite('e2e-inv-invitee@example.test');
      const token = tokenFrom(created);

      const first = await request('POST', '/api/v1/invitations/accept', undefined, {
        token,
        password: PASSWORD,
      });
      expect(first.statusCode).toBe(200);

      // A link that still worked after use would let anyone who saw it in a
      // forwarded email join the company.
      const second = await request('POST', '/api/v1/invitations/accept', undefined, {
        token,
        password: PASSWORD,
      });
      expect(second.statusCode).toBe(404);
    });

    it('grants location scope and staffing together', async () => {
      const created = await invite('e2e-inv-invitee@example.test', {
        roleKey: 'employee',
        scope: 'LOCATION',
        locationIds: [downtownId],
      });

      const accepted = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
        password: PASSWORD,
      });
      const cookie = accepted.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!;

      const locations = await request('GET', '/api/v1/locations', cookie.value);
      const names = json(locations).locations.map((l: { name: string }) => l.name);

      expect(names).toEqual(['Downtown']);

      // And they appear in the location's people list, not only in the
      // permission tables.
      const members = await request('GET', `/api/v1/locations/${downtownId}/members`, adminToken);
      const emails = json(members).members.map((m: { email: string }) => m.email);
      expect(emails).toContain('e2e-inv-invitee@example.test');
    });

    it('does not grant access to unnamed locations', async () => {
      const created = await invite('e2e-inv-invitee@example.test', {
        roleKey: 'employee',
        scope: 'LOCATION',
        locationIds: [downtownId],
      });

      const accepted = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
        password: PASSWORD,
      });
      const cookie = accepted.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!;

      const response = await request('GET', `/api/v1/locations/${warehouseId}`, cookie.value);
      expect(response.statusCode).toBe(404);
    });

    it('requires a password when the invitee has no account', async () => {
      const created = await invite('e2e-inv-invitee@example.test');

      const response = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a weak password', async () => {
      const created = await invite('e2e-inv-invitee@example.test');

      const response = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
        password: 'short',
      });

      expect(response.statusCode).toBe(400);
    });

    it('stores an argon2id hash for the new account', async () => {
      const created = await invite('e2e-inv-invitee@example.test');
      await request('POST', '/api/v1/invitations/accept', undefined, {
        token: tokenFrom(created),
        password: PASSWORD,
      });

      const user = await privileged.user.findUniqueOrThrow({
        where: { email: 'e2e-inv-invitee@example.test' },
      });

      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
    });
  });

  // -------------------------------------------------------------------------

  describe('privilege escalation', () => {
    it('a Location Manager cannot invite an Organization Administrator', async () => {
      // Set up a manager scoped to Downtown.
      const reg = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-inv-mgr@example.test',
        password: PASSWORD,
        organizationName: 'Invite Throwaway',
      });
      const mgrUserId = json(reg).user.id;

      await privileged.organizationMembership.deleteMany({ where: { userId: mgrUserId } });
      await privileged.organization.deleteMany({ where: { name: 'Invite Throwaway' } });

      const membership = await privileged.organizationMembership.create({
        data: { userId: mgrUserId, organizationId, role: 'MEMBER' },
      });
      const assignment = await privileged.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: SYSTEM_ROLE_IDS.location_manager,
          scope: 'LOCATION',
          organizationId,
        },
      });
      await privileged.membershipRoleLocation.create({
        data: { membershipRoleId: assignment.id, locationId: downtownId, organizationId },
      });

      const login = await request('POST', '/api/v1/auth/login', undefined, {
        email: 'e2e-inv-mgr@example.test',
        password: PASSWORD,
      });
      const mgrToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const response = await request('POST', '/api/v1/invitations', mgrToken, {
        email: 'e2e-inv-invitee2@example.test',
        roleKey: 'org_admin',
        scope: 'ORGANIZATION',
        locationIds: [],
      });

      // Granting a role you do not hold yourself is privilege escalation.
      expect(response.statusCode).toBe(400);

      await privileged.user.deleteMany({ where: { email: 'e2e-inv-mgr@example.test' } });
    });
  });
});
