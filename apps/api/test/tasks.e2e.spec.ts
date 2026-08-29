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
 * Tasks, and above all who can see which one.
 *
 * Two rules carry the phase and both are easy to get wrong:
 *
 *   - a task assigned to you is visible wherever it sits
 *   - a task NEVER reveals a customer you are not allowed to see
 *
 * The second is the subtle one. A task is visible because of where it sits or
 * who holds it, neither of which says anything about the customer it concerns.
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

describe('Tasks (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let manager: Actor;
  let employee: Actor;

  let downtownId: string;
  let northsideId: string;

  let downtownCustomerId: string;
  let northsideCustomerId: string;

  let otherToken: string;
  let otherTaskId: string;

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
  const titles = (r: InjectResult): string[] =>
    json(r).tasks.map((t: { title: string }) => t.title);

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-task-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Task Test%'");
  }

  async function addPerson(
    slug: string,
    roleId: string,
    scope: 'ORGANIZATION' | 'LOCATION',
    locationIds: string[] = [],
  ): Promise<Actor> {
    const email = `e2e-task-${slug}@example.test`;

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `Task Test Throwaway ${slug}`,
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Task Test Throwaway ${slug}` } });

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

    return {
      token: login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value,
      userId,
      membershipId: membership.id,
    };
  }

  const makeTask = (token: string, body: Record<string, unknown>) =>
    request('POST', '/api/v1/tasks', token, body);

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-task-admin@example.test',
      password: PASSWORD,
      organizationName: 'Task Test Company',
    });
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

    await request('POST', `/api/v1/modules/${MODULES.CRM}`, adminToken);

    const downtown = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Downtown',
      timezone: 'UTC',
    });
    const northside = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Northside',
      timezone: 'UTC',
    });
    downtownId = json(downtown).location.id;
    northsideId = json(northside).location.id;

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, 'LOCATION', [
      downtownId,
    ]);
    employee = await addPerson('employee', SYSTEM_ROLE_IDS.employee, 'LOCATION', [downtownId]);

    downtownCustomerId = (
      await privileged.customer.create({
        data: {
          organizationId,
          displayName: 'Downtown Dana',
          type: 'PERSON',
          stage: 'ACTIVE',
          locationId: downtownId,
        },
        select: { id: true },
      })
    ).id;

    northsideCustomerId = (
      await privileged.customer.create({
        data: {
          organizationId,
          displayName: 'Northside Nils',
          type: 'PERSON',
          stage: 'ACTIVE',
          locationId: northsideId,
        },
        select: { id: true },
      })
    ).id;

    // A competitor, for isolation.
    const other = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-task-other@example.test',
      password: PASSWORD,
      organizationName: 'Task Test Competitor',
    });
    otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    otherTaskId = json(await makeTask(otherToken, { title: 'Secret competitor work' })).task.id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never lists another organization task', async () => {
      const response = await request('GET', '/api/v1/tasks', admin.token);

      expect(titles(response)).not.toContain('Secret competitor work');
    });

    it('reports one as not found, never forbidden', async () => {
      expect((await request('GET', `/api/v1/tasks/${otherTaskId}`, admin.token)).statusCode).toBe(
        404,
      );
    });

    it('refuses to edit or delete one', async () => {
      expect(
        (await request('PATCH', `/api/v1/tasks/${otherTaskId}`, admin.token, { title: 'Stolen' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await request('DELETE', `/api/v1/tasks/${otherTaskId}`, admin.token)).statusCode,
      ).toBe(404);

      expect(await privileged.task.findUnique({ where: { id: otherTaskId } })).not.toBeNull();
    });

    it('refuses to attach another organization customer', async () => {
      const theirCustomer = await privileged.customer.create({
        data: {
          organizationId: (
            await privileged.organization.findFirstOrThrow({
              where: { name: 'Task Test Competitor' },
            })
          ).id,
          displayName: 'Their Client',
          type: 'PERSON',
        },
        select: { id: true },
      });

      const response = await makeTask(admin.token, {
        title: 'Cross-tenant attempt',
        customerId: theirCustomer.id,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('the customer a task concerns', () => {
    let taskId: string;

    beforeAll(async () => {
      taskId = json(
        await makeTask(admin.token, {
          title: 'Quote the Northside hedge',
          customerId: northsideCustomerId,
          locationId: downtownId,
          assigneeMembershipId: employee.membershipId,
        }),
      ).task.id;
    });

    it('shows the customer to someone allowed to see them', async () => {
      const response = await request('GET', `/api/v1/tasks/${taskId}`, admin.token);

      expect(json(response).task.customerName).toBe('Northside Nils');
      expect(json(response).task.customerId).toBe(northsideCustomerId);
    });

    it('HIDES the customer from someone who is not', async () => {
      // The employee can see the task — it is at their branch and assigned to
      // them — but the customer belongs to a branch they do not work at.
      const response = await request('GET', `/api/v1/tasks/${taskId}`, employee.token);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).task.title).toBe('Quote the Northside hedge');

      // Returning the name here would let anyone with a task list enumerate
      // customers at branches they have no access to, straight past Phase 7.
      expect(json(response).task.customerName).toBeNull();
    });

    it('hides the id too, not just the name', async () => {
      const response = await request('GET', `/api/v1/tasks/${taskId}`, employee.token);

      // An id that 404s on the customer endpoint still confirms the record
      // exists, which is the leak in a slower form.
      expect(json(response).task.customerId).toBeNull();
    });

    it('shows a customer at the reader own branch', async () => {
      const own = json(
        await makeTask(admin.token, {
          title: 'Call Dana back',
          customerId: downtownCustomerId,
          locationId: downtownId,
        }),
      ).task.id;

      const response = await request('GET', `/api/v1/tasks/${own}`, employee.token);
      expect(json(response).task.customerName).toBe('Downtown Dana');
    });
  });

  // =========================================================================

  describe('visibility', () => {
    let northsideTaskId: string;

    beforeAll(async () => {
      northsideTaskId = json(
        await makeTask(admin.token, { title: 'Northside only work', locationId: northsideId }),
      ).task.id;

      await makeTask(admin.token, { title: 'Downtown work', locationId: downtownId });
      await makeTask(admin.token, { title: 'Company-wide work' });
    });

    it('an organization-wide role sees everything', async () => {
      const seen = titles(await request('GET', '/api/v1/tasks?limit=100', admin.token));

      expect(seen).toContain('Northside only work');
      expect(seen).toContain('Downtown work');
      expect(seen).toContain('Company-wide work');
    });

    it('a scoped role sees only their branch', async () => {
      const seen = titles(await request('GET', '/api/v1/tasks?limit=100', manager.token));

      expect(seen).toContain('Downtown work');
      expect(seen).not.toContain('Northside only work');
    });

    it('a task with no location is invisible to a scoped role', async () => {
      // Company-wide work belongs to whoever runs the company, the same rule
      // an unassigned location and an unassigned customer already follow.
      expect(titles(await request('GET', '/api/v1/tasks?limit=100', manager.token))).not.toContain(
        'Company-wide work',
      );
    });

    it('cannot reach another branch task by id', async () => {
      expect(
        (await request('GET', `/api/v1/tasks/${northsideTaskId}`, manager.token)).statusCode,
      ).toBe(404);
    });

    it('BUT a task assigned to you is visible wherever it sits', async () => {
      const assigned = json(
        await makeTask(admin.token, {
          title: 'Cover the Northside job',
          locationId: northsideId,
          assigneeMembershipId: manager.membershipId,
        }),
      ).task.id;

      // The whole point of the rule: assigning across branches must not fail
      // silently, leaving work nobody can find.
      const direct = await request('GET', `/api/v1/tasks/${assigned}`, manager.token);
      expect(direct.statusCode, direct.body).toBe(200);

      expect(titles(await request('GET', '/api/v1/tasks?limit=100', manager.token))).toContain(
        'Cover the Northside job',
      );
    });

    it('and that does not widen sight of the branch itself', async () => {
      // Being handed one job at Northside grants that job, not the branch.
      expect(titles(await request('GET', '/api/v1/tasks?limit=100', manager.token))).not.toContain(
        'Northside only work',
      );
    });
  });

  // =========================================================================

  describe('who may change what', () => {
    it('an employee cannot create a task', async () => {
      const response = await makeTask(employee.token, {
        title: 'Should not exist',
        locationId: downtownId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('an employee cannot retitle a task', async () => {
      const id = json(
        await makeTask(admin.token, { title: 'Fix the gate', locationId: downtownId }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, employee.token, {
        title: 'Renamed by employee',
      });

      expect(response.statusCode).toBe(403);
    });

    it('BUT an assignee can always complete their own work', async () => {
      const id = json(
        await makeTask(admin.token, {
          title: 'Mow the verge',
          locationId: downtownId,
          assigneeMembershipId: employee.membershipId,
        }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, employee.token, {
        status: 'DONE',
      });

      // Handing someone work they cannot mark as done would be absurd.
      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).task.status).toBe('DONE');
      expect(json(response).task.completedAt).not.toBeNull();
    });

    it('an assignee may change the status and NOTHING else', async () => {
      const id = json(
        await makeTask(admin.token, {
          title: 'Trim the hedge',
          locationId: downtownId,
          assigneeMembershipId: employee.membershipId,
        }),
      ).task.id;

      // Smuggling a retitle alongside a legitimate status change.
      const response = await request('PATCH', `/api/v1/tasks/${id}`, employee.token, {
        status: 'DONE',
        title: 'Something else entirely',
      });

      expect(response.statusCode).toBe(403);

      const untouched = await privileged.task.findUniqueOrThrow({ where: { id } });
      expect(untouched.title).toBe('Trim the hedge');
      expect(untouched.status).toBe('TODO');
    });

    it('an assignee cannot hand the task to somebody else', async () => {
      const id = json(
        await makeTask(admin.token, {
          title: 'Clear the gutters',
          locationId: downtownId,
          assigneeMembershipId: employee.membershipId,
        }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, employee.token, {
        assigneeMembershipId: manager.membershipId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('a manager may not move a task to a branch they do not run', async () => {
      const id = json(
        await makeTask(admin.token, { title: 'Stays downtown', locationId: downtownId }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, manager.token, {
        locationId: northsideId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('a manager may not create company-wide work', async () => {
      const response = await makeTask(manager.token, { title: 'Company-wide by manager' });

      expect(response.statusCode).toBe(403);
    });

    it('deleting needs more than write', async () => {
      const id = json(await makeTask(admin.token, { title: 'Doomed task', locationId: downtownId }))
        .task.id;

      expect((await request('DELETE', `/api/v1/tasks/${id}`, manager.token)).statusCode).toBe(403);
      expect((await request('DELETE', `/api/v1/tasks/${id}`, admin.token)).statusCode).toBe(204);
    });
  });

  // =========================================================================

  describe('status and dates', () => {
    it('stamps completion on the first DONE only', async () => {
      const id = json(
        await makeTask(admin.token, { title: 'Reopened work', locationId: downtownId }),
      ).task.id;

      const done = await request('PATCH', `/api/v1/tasks/${id}`, admin.token, { status: 'DONE' });
      const first = json(done).task.completedAt;
      expect(first).not.toBeNull();

      await request('PATCH', `/api/v1/tasks/${id}`, admin.token, { status: 'TODO' });
      const again = await request('PATCH', `/api/v1/tasks/${id}`, admin.token, { status: 'DONE' });

      // Re-stamping would rewrite when the work was actually first delivered.
      expect(json(again).task.completedAt).toBe(first);
    });

    it('BLOCKED is a real state, not a flag', async () => {
      const id = json(
        await makeTask(admin.token, { title: 'Waiting on the customer', locationId: downtownId }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, admin.token, {
        status: 'BLOCKED',
      });

      expect(json(response).task.status).toBe('BLOCKED');
      expect(json(response).task.completedAt).toBeNull();
    });

    it('refuses a task with no title', async () => {
      expect((await makeTask(admin.token, { title: '   ' })).statusCode).toBe(400);
    });

    it('emptying the description actually clears it', async () => {
      const id = json(
        await makeTask(admin.token, {
          title: 'Has a note',
          description: 'Ring the bell twice',
          locationId: downtownId,
        }),
      ).task.id;

      // An empty box means "remove this". Treating it as "not mentioned"
      // leaves the old note in place and still reports success, which is the
      // worst of both.
      const response = await request('PATCH', `/api/v1/tasks/${id}`, admin.token, {
        description: '',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).task.description).toBeNull();
    });

    it('an edit that does not mention the description leaves it alone', async () => {
      const id = json(
        await makeTask(admin.token, {
          title: 'Keeps its note',
          description: 'Gate code 4821',
          locationId: downtownId,
        }),
      ).task.id;

      const response = await request('PATCH', `/api/v1/tasks/${id}`, admin.token, {
        title: 'Keeps its note, retitled',
      });

      expect(json(response).task.description).toBe('Gate code 4821');
    });
  });

  // =========================================================================

  describe('finding work', () => {
    it('filters to open work only', async () => {
      const response = await request('GET', '/api/v1/tasks?openOnly=true&limit=100', admin.token);

      for (const task of json(response).tasks) {
        expect(['TODO', 'IN_PROGRESS', 'BLOCKED']).toContain(task.status);
      }
    });

    it('finds what is assigned to me without knowing my own id', async () => {
      const response = await request('GET', '/api/v1/tasks?mine=true&limit=100', employee.token);

      for (const task of json(response).tasks) {
        expect(task.assigneeMembershipId).toBe(employee.membershipId);
      }
      expect(json(response).tasks.length).toBeGreaterThan(0);
    });

    it('overdue means past due AND still open', async () => {
      const past = new Date(Date.now() - 86_400_000).toISOString();

      const stillOpen = json(
        await makeTask(admin.token, {
          title: 'Late and open',
          locationId: downtownId,
          dueAt: past,
        }),
      ).task.id;

      const finished = json(
        await makeTask(admin.token, {
          title: 'Late but finished',
          locationId: downtownId,
          dueAt: past,
        }),
      ).task.id;
      await request('PATCH', `/api/v1/tasks/${finished}`, admin.token, { status: 'DONE' });

      const overdue = titles(
        await request('GET', '/api/v1/tasks?overdue=true&limit=100', admin.token),
      );

      // A task finished late is done, not overdue. A list that can never be
      // cleared is a list people stop reading.
      expect(overdue).toContain('Late and open');
      expect(overdue).not.toContain('Late but finished');
      expect(stillOpen).toBeTruthy();
    });

    it('filters by customer', async () => {
      const response = await request(
        'GET',
        `/api/v1/tasks?customerId=${downtownCustomerId}&limit=100`,
        admin.token,
      );

      for (const task of json(response).tasks) {
        expect(task.customerId).toBe(downtownCustomerId);
      }
    });

    it('search respects scope, so it cannot be used to probe', async () => {
      const response = await request('GET', '/api/v1/tasks?search=Northside', manager.token);

      expect(titles(response)).not.toContain('Northside only work');
    });

    it('rejects a nonsense limit', async () => {
      expect((await request('GET', '/api/v1/tasks?limit=99999', admin.token)).statusCode).toBe(400);
    });
  });
});
