import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Employee groups.
 *
 * Labels for organising people, and nothing more. The tests that matter most
 * prove the "nothing more": another business cannot see or touch them, only
 * managers change them, and being in one grants no permission at all.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Person {
  token: string;
  userId: string;
  organizationId: string;
  membershipId: string;
}

describe('Employee groups (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let owner: Person;
  let employee: Person;
  let outsider: Person;

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

  const json = (r: InjectResult) => JSON.parse(r.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  async function membershipOf(userId: string) {
    return privileged.organizationMembership.findFirstOrThrow({ where: { userId } });
  }

  async function register(email: string, organizationName: string): Promise<Person> {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName,
    });
    expect(response.statusCode, response.body).toBe(201);
    const userId = json(response).user.id as string;
    const membership = await membershipOf(userId);
    return {
      token: tokenOf(response),
      userId,
      organizationId: membership.organizationId,
      membershipId: membership.id,
    };
  }

  const createGroup = (token: string, name: string, color = 'blue') =>
    request('POST', '/api/v1/groups', token, { name, color });
  const setGroups = (token: string, membershipId: string, groupIds: string[]) =>
    request('PUT', `/api/v1/organizations/current/members/${membershipId}/groups`, token, {
      groupIds,
    });

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-groups-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Groups Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    owner = await register('e2e-groups-owner@example.test', 'Groups Test Company');
    outsider = await register('e2e-groups-outsider@example.test', 'Groups Test Rival');

    // An employee, joined the way real people join.
    const invited = await request('POST', '/api/v1/invitations', owner.token, {
      email: 'e2e-groups-employee@example.test',
      roleKey: 'employee',
      scope: 'ORGANIZATION',
      locationIds: [],
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const accepted = await request('POST', '/api/v1/invitations/accept', undefined, {
      token: new URL(json(invited).acceptUrl).searchParams.get('token'),
      password: PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const employeeUser = await privileged.user.findUniqueOrThrow({
      where: { email: 'e2e-groups-employee@example.test' },
    });
    const employeeMembership = await membershipOf(employeeUser.id);
    employee = {
      token: tokenOf(accepted),
      userId: employeeUser.id,
      organizationId: owner.organizationId,
      membershipId: employeeMembership.id,
    };
  });

  beforeEach(async () => {
    await privileged.memberGroup.deleteMany({
      where: { organizationId: { in: [owner.organizationId, outsider.organizationId] } },
    });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  it('lets an owner create groups and put people in them', async () => {
    const field = json(await createGroup(owner.token, 'Field crew', 'green'));
    const office = json(await createGroup(owner.token, 'Office', 'violet'));

    const set = await setGroups(owner.token, employee.membershipId, [field.id, office.id]);
    expect(set.statusCode, set.body).toBe(200);

    const members = json(await request('GET', '/api/v1/organizations/current/members', owner.token))
      .members as Array<{ membershipId: string; groupIds: string[] }>;
    const person = members.find((m) => m.membershipId === employee.membershipId)!;
    expect(person.groupIds.sort()).toEqual([field.id, office.id].sort());

    const groups = json(await request('GET', '/api/v1/groups', owner.token)).groups;
    expect(
      groups.map((g: { name: string; memberCount: number }) => [g.name, g.memberCount]),
    ).toEqual([
      ['Field crew', 1],
      ['Office', 1],
    ]);

    // Setting replaces: down to one group.
    await setGroups(owner.token, employee.membershipId, [field.id]);
    const after = json(await request('GET', '/api/v1/organizations/current/members', owner.token))
      .members as Array<{ membershipId: string; groupIds: string[] }>;
    expect(after.find((m) => m.membershipId === employee.membershipId)!.groupIds).toEqual([
      field.id,
    ]);
  });

  it('refuses a second group with the same name, whatever the capitals', async () => {
    await createGroup(owner.token, 'Office');
    const duplicate = await createGroup(owner.token, '  office ');
    expect(duplicate.statusCode).toBe(409);
  });

  it('lets only people who manage the team change groups', async () => {
    const office = json(await createGroup(owner.token, 'Office'));

    expect((await createGroup(employee.token, 'Mine')).statusCode).toBe(403);
    expect(
      (
        await request('PATCH', `/api/v1/groups/${office.id}`, employee.token, {
          name: 'Taken over',
        })
      ).statusCode,
    ).toBe(403);
    expect((await setGroups(employee.token, employee.membershipId, [office.id])).statusCode).toBe(
      403,
    );
    expect(
      (await request('DELETE', `/api/v1/groups/${office.id}`, employee.token)).statusCode,
    ).toBe(403);
  });

  it('grants nothing: joining a group leaves permissions exactly as they were', async () => {
    const before = json(await request('GET', '/api/v1/organizations/current', employee.token));

    const office = json(await createGroup(owner.token, 'Office'));
    await setGroups(owner.token, employee.membershipId, [office.id]);

    const after = json(await request('GET', '/api/v1/organizations/current', employee.token));
    expect(after.permissions).toEqual(before.permissions);
    expect(after.roles).toEqual(before.roles);

    // And a manager-only action is still refused.
    expect((await createGroup(employee.token, 'Promoted myself')).statusCode).toBe(403);
  });

  it('never shows or lets another business touch its groups', async () => {
    const office = json(await createGroup(owner.token, 'Office'));

    const theirs = json(await request('GET', '/api/v1/groups', outsider.token)).groups;
    expect(theirs).toEqual([]);

    const rename = await request('PATCH', `/api/v1/groups/${office.id}`, outsider.token, {
      name: 'Hijacked',
    });
    expect(rename.statusCode).toBe(404);
    expect(
      (await request('DELETE', `/api/v1/groups/${office.id}`, outsider.token)).statusCode,
    ).toBe(404);

    // Their own person into our group, or our person into theirs: not found.
    expect((await setGroups(outsider.token, outsider.membershipId, [office.id])).statusCode).toBe(
      404,
    );
    const rival = json(await createGroup(outsider.token, 'Rival crew'));
    expect((await setGroups(outsider.token, employee.membershipId, [rival.id])).statusCode).toBe(
      404,
    );
  });

  it('refuses, in the database, a group row that mixes two businesses', async () => {
    const office = json(await createGroup(owner.token, 'Office'));

    // Even the owner role, which ignores row-level security, is stopped by the trigger.
    await expect(
      privileged.memberGroupMember.create({
        data: {
          groupId: office.id,
          membershipId: outsider.membershipId,
          organizationId: owner.organizationId,
        },
      }),
    ).rejects.toThrow();
  });

  it('removes only the label when a group is deleted', async () => {
    const office = json(await createGroup(owner.token, 'Office'));
    await setGroups(owner.token, employee.membershipId, [office.id]);
    const before = json(await request('GET', '/api/v1/organizations/current', employee.token));

    expect((await request('DELETE', `/api/v1/groups/${office.id}`, owner.token)).statusCode).toBe(
      204,
    );

    const members = json(await request('GET', '/api/v1/organizations/current/members', owner.token))
      .members as Array<{ membershipId: string; groupIds: string[] }>;
    const person = members.find((m) => m.membershipId === employee.membershipId);
    expect(person?.groupIds).toEqual([]);

    const after = json(await request('GET', '/api/v1/organizations/current', employee.token));
    expect(after.permissions).toEqual(before.permissions);
  });
});
