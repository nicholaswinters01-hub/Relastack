import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME, SUPPORT_REQUESTS_PER_DAY } from '@platform/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { DispatcherService } from '../src/notifications/dispatcher.service';
import { EmailService, type EmailMessage } from '../src/notifications/email.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * The help desk (Phase 19c).
 *
 * What matters most, in order:
 *   - a business sees only its own requests, and within it only the person
 *     who asked and the owners see one
 *   - staff can read every request and still no customer data
 *   - nobody can edit or delete what was said, or speak as someone else
 *   - a lapsed business can still ask for help
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
}

describe('Help desk (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let prisma: PrismaService;
  let send: MockInstance<(message: EmailMessage) => Promise<void>>;

  let staff: Person;
  let owner: Person;
  let employee: Person;
  let colleague: Person;
  let outsider: Person;

  const request = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  async function register(email: string, organizationName: string): Promise<Person> {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName,
    });
    expect(response.statusCode, response.body).toBe(201);
    const userId = json(response).user.id as string;
    const { organizationId } = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId },
    });
    return { token: tokenOf(response), userId, organizationId };
  }

  /** An employee of the owner's business, joined the way real people join. */
  async function hire(email: string): Promise<Person> {
    const invited = await request('POST', '/api/v1/invitations', owner.token, {
      email,
      roleKey: 'employee',
      scope: 'ORGANIZATION',
      locationIds: [],
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const token = new URL(json(invited).acceptUrl).searchParams.get('token');

    const accepted = await request('POST', '/api/v1/invitations/accept', undefined, {
      token,
      password: PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    return {
      token: tokenOf(accepted),
      userId: (await privileged.user.findUniqueOrThrow({ where: { email } })).id,
      organizationId: owner.organizationId,
    };
  }

  const ask = (person: Person, subject = 'How do I add a crew?') =>
    request('POST', '/api/v1/support/requests', person.token, {
      kind: 'QUESTION',
      subject,
      body: 'I cannot find where to add people to a job.',
    });

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM staff_audit_events WHERE staff_email LIKE 'e2e-help-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-help-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Help Test%'");
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();
    send = vi.spyOn(app.get(EmailService), 'send').mockResolvedValue();

    staff = await register('e2e-help-staff@example.test', 'Help Test Home');
    await privileged.platformStaff.create({ data: { userId: staff.userId, note: 'e2e' } });

    owner = await register('e2e-help-owner@example.test', 'Help Test Alpha');
    employee = await hire('e2e-help-employee@example.test');
    colleague = await hire('e2e-help-colleague@example.test');
    outsider = await register('e2e-help-outsider@example.test', 'Help Test Beta');

    // Something the business keeps about its own customers.
    await privileged.customer.create({
      data: {
        organizationId: owner.organizationId,
        displayName: 'Private Customer',
        type: 'PERSON',
        stage: 'ACTIVE',
      },
    });
  });

  beforeEach(async () => {
    send.mockClear();
    await privileged.supportRequest.deleteMany({
      where: { organizationId: { in: [owner.organizationId, outsider.organizationId] } },
    });
    await privileged.subscription.updateMany({
      where: { organizationId: owner.organizationId },
      data: { status: 'TRIALING', trialEndsAt: new Date(Date.now() + 14 * 86_400_000) },
    });
  });

  afterAll(async () => {
    send?.mockRestore();
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('asking', () => {
    it('lets anyone in a business ask, and tells staff by email', async () => {
      const response = await ask(employee);
      expect(response.statusCode, response.body).toBe(201);

      const staffEmail = send.mock.calls.find((c) => c[0].to === 'hello@relastack.com');
      expect(staffEmail?.[0].subject).toContain('Help Test Alpha');
      expect(staffEmail?.[0].link).toContain(`/staff/help/${json(response).id}`);
    });

    it('still lets a read-only business ask', async () => {
      await privileged.subscription.updateMany({
        where: { organizationId: owner.organizationId },
        data: { status: 'SUSPENDED', trialEndsAt: new Date(Date.now() - 86_400_000) },
      });
      // Read-only really is in force...
      const blocked = await request('POST', '/api/v1/locations', owner.token, {
        name: 'Blocked Yard',
        timezone: 'UTC',
      });
      expect(blocked.statusCode).toBe(403);

      // ...and help is still reachable.
      const response = await ask(owner, 'Why can I not change anything?');
      expect(response.statusCode, response.body).toBe(201);
      const reply = await request(
        'POST',
        `/api/v1/support/requests/${json(response).id}/messages`,
        owner.token,
        { body: 'Still stuck.' },
      );
      expect(reply.statusCode).toBe(204);
    });

    it(`stops at ${SUPPORT_REQUESTS_PER_DAY} requests a day per business`, async () => {
      for (let i = 0; i < SUPPORT_REQUESTS_PER_DAY; i += 1) {
        expect((await ask(employee, `Question ${i}`)).statusCode).toBe(201);
      }

      expect((await ask(owner, 'One more')).statusCode).toBe(429);
    });
  });

  // =========================================================================

  describe('who sees a request', () => {
    it('shows it to whoever asked and to the owner, and to no other colleague', async () => {
      const id = json(await ask(employee)).id as string;

      expect(
        (await request('GET', `/api/v1/support/requests/${id}`, employee.token)).statusCode,
      ).toBe(200);
      expect((await request('GET', `/api/v1/support/requests/${id}`, owner.token)).statusCode).toBe(
        200,
      );
      expect(
        (await request('GET', `/api/v1/support/requests/${id}`, colleague.token)).statusCode,
      ).toBe(404);

      const listed = json(await request('GET', '/api/v1/support/requests', colleague.token));
      expect(listed.requests).toHaveLength(0);

      const reply = await request(
        'POST',
        `/api/v1/support/requests/${id}/messages`,
        colleague.token,
        {
          body: 'Sneaking in',
        },
      );
      expect(reply.statusCode).toBe(404);
    });

    it('never shows one business another business’s request', async () => {
      const id = json(await ask(employee)).id as string;

      expect(
        (await request('GET', `/api/v1/support/requests/${id}`, outsider.token)).statusCode,
      ).toBe(404);

      // Proven against the database too, not just the endpoint.
      const seen = await prisma.withTenant(
        { organizationId: outsider.organizationId, userId: outsider.userId },
        (tx) => tx.supportRequest.findMany({ where: { id } }),
      );
      expect(seen).toHaveLength(0);
    });
  });

  // =========================================================================

  describe('the staff inbox', () => {
    it('lists requests from every business, and still shows staff no customers', async () => {
      const alpha = json(await ask(employee)).id;
      const beta = json(await ask(outsider)).id;

      const inbox = json(await request('GET', '/api/v1/staff/support?filter=open', staff.token));
      const ids = inbox.requests.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining([alpha, beta]));

      const customers = await prisma.withStaff(staff.userId, (tx) =>
        tx.customer.findMany({ where: { organizationId: owner.organizationId } }),
      );
      expect(customers).toHaveLength(0);
    });

    it('answers a customer as if the inbox did not exist', async () => {
      const id = json(await ask(owner)).id;

      expect((await request('GET', '/api/v1/staff/support', owner.token)).statusCode).toBe(404);
      const reply = await request('POST', `/api/v1/staff/support/${id}/messages`, owner.token, {
        body: 'Replying as staff',
      });
      expect(reply.statusCode).toBe(404);
    });

    it('replies: the business sees it signed by the team, the asker is notified and emailed once', async () => {
      const id = json(await ask(employee)).id as string;

      const reply = await request('POST', `/api/v1/staff/support/${id}/messages`, staff.token, {
        body: 'Open the job and use Crew.',
      });
      expect(reply.statusCode, reply.body).toBe(204);

      const thread = json(await request('GET', `/api/v1/support/requests/${id}`, employee.token));
      expect(thread.status).toBe('WAITING_ON_CUSTOMER');
      expect(thread.messages.at(-1)).toMatchObject({ fromStaff: true, authorLabel: 'RelaStack' });
      expect(JSON.stringify(thread)).not.toContain('e2e-help-staff');

      const dispatcher = app.get(DispatcherService);
      await dispatcher.drain();
      await dispatcher.drain();

      const notified = await privileged.notification.findMany({
        where: { type: 'support.replied', organizationId: owner.organizationId },
      });
      expect(notified).toHaveLength(1);
      expect(notified[0]!.linkPath).toBe(`/help/${id}`);

      const emailed = send.mock.calls.filter(
        (c) => c[0].to === 'e2e-help-employee@example.test' && c[0].subject.includes('replied'),
      );
      expect(emailed).toHaveLength(1);

      const audit = await privileged.staffAuditEvent.findFirst({
        where: { action: 'support.replied', organizationId: owner.organizationId },
      });
      expect(audit?.staffEmail).toBe('e2e-help-staff@example.test');
    });

    it('reopens a request when the business answers back', async () => {
      const id = json(await ask(employee)).id as string;
      await request('POST', `/api/v1/staff/support/${id}/messages`, staff.token, {
        body: 'Done, closing this.',
        status: 'RESOLVED',
      });

      await request('POST', `/api/v1/support/requests/${id}/messages`, employee.token, {
        body: 'Actually it happened again.',
      });

      const thread = json(await request('GET', `/api/v1/staff/support/${id}`, staff.token));
      expect(thread.status).toBe('OPEN');
    });
  });

  // =========================================================================

  describe('what the database allows', () => {
    it('does not let anyone edit or delete a message', async () => {
      const id = json(await ask(employee)).id as string;

      await expect(
        prisma.withStaff(staff.userId, (tx) =>
          tx.supportMessage.updateMany({ where: { requestId: id }, data: { body: 'rewritten' } }),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withStaff(staff.userId, (tx) => tx.supportMessage.deleteMany({})),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withTenant({ organizationId: owner.organizationId, userId: owner.userId }, (tx) =>
          tx.supportMessage.deleteMany({}),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let a business write as staff, or as a colleague', async () => {
      const id = json(await ask(employee)).id as string;
      const context = { organizationId: owner.organizationId, userId: owner.userId };

      await expect(
        prisma.withTenant(context, (tx) =>
          tx.supportMessage.create({
            data: {
              requestId: id,
              organizationId: owner.organizationId,
              authorUserId: owner.userId,
              authorEmail: 'support@relastack.com',
              fromStaff: true,
              body: 'Official-looking answer',
            },
          }),
        ),
      ).rejects.toThrow();

      await expect(
        prisma.withTenant(context, (tx) =>
          tx.supportMessage.create({
            data: {
              requestId: id,
              organizationId: owner.organizationId,
              authorUserId: employee.userId,
              authorEmail: 'e2e-help-employee@example.test',
              fromStaff: false,
              body: 'Pretending to be the employee',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('does not let staff post as another staff member', async () => {
      const id = json(await ask(employee)).id as string;

      await expect(
        prisma.withStaff(staff.userId, (tx) =>
          tx.supportMessage.create({
            data: {
              requestId: id,
              organizationId: owner.organizationId,
              authorUserId: owner.userId,
              authorEmail: 'someone-else@example.test',
              fromStaff: true,
              body: 'Forged',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('lets staff add no event but a help reply', async () => {
      await expect(
        prisma.withStaff(
          staff.userId,
          (tx) =>
            tx.$executeRaw`
            INSERT INTO domain_events (id, organization_id, type, payload)
            VALUES (gen_random_uuid(), ${owner.organizationId}::uuid, 'subscription.read_only', '{}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });
  });
});
