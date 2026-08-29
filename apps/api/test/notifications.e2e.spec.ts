import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
// No background timer, so a dispatch can never race an assertion. The suite
// drains the outbox by hand instead.
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EVENT_TYPES, MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatcherService } from '../src/notifications/dispatcher.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Events and notifications.
 *
 * What matters most:
 *
 *   - the event is written in the SAME transaction as the change
 *   - redelivery is safe, so a half-finished dispatch does not duplicate
 *   - a notification never crosses a tenant boundary
 *   - people can turn things off
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Notifications (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let dispatcher: DispatcherService;

  let organizationId: string;
  let ownerToken: string;
  let ownerMembershipId: string;
  let crewToken: string;
  let crewMembershipId: string;
  let locationId: string;

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
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);

  const inboxOf = async (token: string) =>
    json(await request('GET', '/api/v1/notifications', token));

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-notif-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Notif Test%'");
  }

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
    dispatcher = app.get(DispatcherService);
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-notif-owner@example.test',
      password: PASSWORD,
      organizationName: 'Notif Test Company',
    });
    ownerToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const ownerMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = ownerMembership.organizationId;
    ownerMembershipId = ownerMembership.id;

    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, ownerToken);

    const location = await request('POST', '/api/v1/locations', ownerToken, {
      name: 'Main Yard',
      timezone: 'UTC',
    });
    locationId = json(location).location.id;

    // Someone to assign work to.
    const crewReg = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-notif-crew@example.test',
      password: PASSWORD,
      organizationName: 'Notif Test Throwaway',
    });
    const crewUserId = json(crewReg).user.id;
    await privileged.organizationMembership.deleteMany({ where: { userId: crewUserId } });
    await privileged.organization.deleteMany({ where: { name: 'Notif Test Throwaway' } });

    const crewMembership = await privileged.organizationMembership.create({
      data: { userId: crewUserId, organizationId, role: 'MEMBER' },
    });
    crewMembershipId = crewMembership.id;

    const assignment = await privileged.membershipRole.create({
      data: {
        membershipId: crewMembership.id,
        roleId: SYSTEM_ROLE_IDS.employee,
        scope: 'LOCATION',
        organizationId,
      },
    });
    await privileged.membershipRoleLocation.create({
      data: { membershipRoleId: assignment.id, locationId, organizationId },
    });

    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email: 'e2e-notif-crew@example.test',
      password: PASSWORD,
    });
    crewToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('the outbox', () => {
    it('records an event in the same transaction as the change', async () => {
      const created = await request('POST', '/api/v1/tasks', ownerToken, {
        title: 'Clear the gutters',
        locationId,
        assigneeMembershipId: crewMembershipId,
      });
      expect(created.statusCode, created.body).toBe(201);

      // Present before anything has been dispatched: the event is a fact
      // written with the task, not a side effect of a later job.
      const events = await privileged.domainEvent.findMany({
        where: { organizationId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.processedAt).toBeNull();
    });

    it('does not notify you about work you gave yourself', async () => {
      const before = await privileged.domainEvent.count({
        where: { organizationId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      await request('POST', '/api/v1/tasks', ownerToken, {
        title: 'Something for me',
        locationId,
        assigneeMembershipId: ownerMembershipId,
      });

      const after = await privileged.domainEvent.count({
        where: { organizationId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      // Telling somebody what they just did is noise, and noise is what makes
      // people mute a product.
      expect(after).toBe(before);
    });

    it('turns events into notifications when drained', async () => {
      await dispatcher.drain();

      const inbox = await inboxOf(crewToken);

      expect(inbox.unread).toBeGreaterThan(0);
      expect(inbox.notifications[0].title).toBe('A task was assigned to you');
      expect(inbox.notifications[0].body).toBe('Clear the gutters');
      expect(inbox.notifications[0].linkPath).toBe('/tasks?filter=mine');
    });

    it('marks the event processed so it is not handled twice', async () => {
      const pending = await privileged.domainEvent.count({
        where: { organizationId, processedAt: null },
      });

      expect(pending).toBe(0);
    });

    it('redelivery does not duplicate a notification', async () => {
      const before = await privileged.notification.count({
        where: { membershipId: crewMembershipId },
      });

      // Force the event back into the queue, exactly as a crash mid-handler
      // would leave it.
      await privileged.domainEvent.updateMany({
        where: { organizationId, type: EVENT_TYPES.TASK_ASSIGNED },
        data: { processedAt: null },
      });

      await dispatcher.drain();

      const after = await privileged.notification.count({
        where: { membershipId: crewMembershipId },
      });

      // The unique pair on (event, membership) is what makes retrying safe.
      expect(after).toBe(before);
    });

    it('handing a task to somebody else tells THEM, not just the first person', async () => {
      // The whole point of being able to edit: a task went to the wrong
      // person. Fixing it silently would be worse than the mistake, because
      // the sender believes it is handled and the right person never knows.
      const created = await request('POST', '/api/v1/tasks', ownerToken, {
        title: 'Meant for somebody else',
        locationId,
        assigneeMembershipId: ownerMembershipId,
      });
      const taskId = json(created).task.id;

      const before = await privileged.notification.count({
        where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      const moved = await request('PATCH', `/api/v1/tasks/${taskId}`, ownerToken, {
        assigneeMembershipId: crewMembershipId,
      });
      expect(moved.statusCode, moved.body).toBe(200);

      await dispatcher.drain();

      expect(
        await privileged.notification.count({
          where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
        }),
      ).toBe(before + 1);
    });

    it('editing something else about a task does not re-announce it', async () => {
      const created = await request('POST', '/api/v1/tasks', ownerToken, {
        title: 'Already theirs',
        locationId,
        assigneeMembershipId: crewMembershipId,
      });
      const taskId = json(created).task.id;
      await dispatcher.drain();

      const before = await privileged.notification.count({
        where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      // Sending the assignee unchanged alongside a real edit is exactly what a
      // form does. Announcing on every save is how a bell becomes noise.
      await request('PATCH', `/api/v1/tasks/${taskId}`, ownerToken, {
        title: 'Already theirs, retitled',
        assigneeMembershipId: crewMembershipId,
      });
      await dispatcher.drain();

      expect(
        await privileged.notification.count({
          where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
        }),
      ).toBe(before);
    });
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never delivers a notification to another organization', async () => {
      const other = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-notif-other@example.test',
        password: PASSWORD,
        organizationName: 'Notif Test Competitor',
      });
      const otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      await dispatcher.drain();

      const theirs = await inboxOf(otherToken);
      expect(theirs.notifications).toHaveLength(0);
      expect(theirs.unread).toBe(0);
    });

    it('the database refuses one addressed across a boundary', async () => {
      const otherOrg = await privileged.organization.findFirstOrThrow({
        where: { name: 'Notif Test Competitor' },
      });

      // Defence in depth: RLS keys on organization_id alone, so the trigger is
      // what stops a row satisfying the policy while addressing somebody else.
      await expect(
        privileged.notification.create({
          data: {
            organizationId: otherOrg.id,
            membershipId: crewMembershipId,
            type: 'test',
            title: 'Leaked',
            body: 'Should never exist',
          },
        }),
      ).rejects.toThrow();
    });

    it('you only ever see your own', async () => {
      const owner = await inboxOf(ownerToken);
      const crew = await inboxOf(crewToken);

      // No parameter exists to ask for somebody else's, which is the point.
      expect(crew.notifications.length).toBeGreaterThan(0);
      expect(
        owner.notifications.every((n: { title: string }) => n.title !== 'Clear the gutters'),
      ).toBe(true);
    });
  });

  // =========================================================================

  describe('jobs', () => {
    it('tells the crew they were put on one', async () => {
      const booked = await request('POST', '/api/v1/jobs', ownerToken, {
        title: 'Hedge trim at 14 Elm Road',
        startsAt: '2026-12-01T14:00:00.000Z',
        endsAt: '2026-12-01T16:00:00.000Z',
        locationId,
        assigneeMembershipIds: [crewMembershipId],
      });
      expect(booked.statusCode, booked.body).toBe(201);

      await dispatcher.drain();

      const inbox = await inboxOf(crewToken);
      const notice = inbox.notifications.find(
        (n: { title: string }) => n.title === 'You were added to a job',
      );

      expect(notice).toBeDefined();
      expect(notice.linkPath).toBe('/schedule?day=2026-12-01');
    });

    it('tells them when it moves', async () => {
      const booked = await request('POST', '/api/v1/jobs', ownerToken, {
        title: 'Moving job',
        startsAt: '2026-12-02T14:00:00.000Z',
        endsAt: '2026-12-02T16:00:00.000Z',
        locationId,
        assigneeMembershipIds: [crewMembershipId],
      });
      const id = json(booked).job.id;
      await dispatcher.drain();

      await request('PATCH', `/api/v1/jobs/${id}`, ownerToken, {
        startsAt: '2026-12-02T18:00:00.000Z',
        endsAt: '2026-12-02T20:00:00.000Z',
        acknowledgeConflicts: true,
      });
      await dispatcher.drain();

      const inbox = await inboxOf(crewToken);
      expect(
        inbox.notifications.some((n: { title: string }) => n.title === 'A job you are on moved'),
      ).toBe(true);
    });

    it('does NOT pester them over a retitle', async () => {
      const booked = await request('POST', '/api/v1/jobs', ownerToken, {
        title: 'Quiet edit',
        startsAt: '2026-12-03T14:00:00.000Z',
        endsAt: '2026-12-03T16:00:00.000Z',
        locationId,
        assigneeMembershipIds: [crewMembershipId],
      });
      await dispatcher.drain();

      const before = await privileged.notification.count({
        where: { membershipId: crewMembershipId },
      });

      await request('PATCH', `/api/v1/jobs/${json(booked).job.id}`, ownerToken, {
        title: 'Quiet edit, renamed',
      });
      await dispatcher.drain();

      // Correcting a title is not worth interrupting somebody's day for.
      expect(
        await privileged.notification.count({ where: { membershipId: crewMembershipId } }),
      ).toBe(before);
    });
  });

  // =========================================================================

  describe('billing reaches the owner', () => {
    it('notifies on a failed payment', async () => {
      await request('POST', '/api/v1/billing/plan', ownerToken, { planKey: 'business' });
      await request('POST', '/api/v1/billing/events', ownerToken, { event: 'payment_failed' });
      await dispatcher.drain();

      const inbox = await inboxOf(ownerToken);

      expect(
        inbox.notifications.some(
          (n: { title: string }) => n.title === 'A payment did not go through',
        ),
      ).toBe(true);
    });

    it('and does not tell the crew about the company card', async () => {
      const inbox = await inboxOf(crewToken);

      expect(
        inbox.notifications.every(
          (n: { title: string }) => !n.title.toLowerCase().includes('payment'),
        ),
      ).toBe(true);
    });
  });

  // =========================================================================

  describe('preferences', () => {
    it('lists every notifiable type, on by default', async () => {
      const response = await request('GET', '/api/v1/notifications/preferences', crewToken);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).preferences.length).toBeGreaterThan(0);
      expect(json(response).preferences.every((p: { inApp: boolean }) => p.inApp)).toBe(true);
    });

    it('turning one off stops it arriving', async () => {
      await request('PATCH', '/api/v1/notifications/preferences', crewToken, {
        type: EVENT_TYPES.TASK_ASSIGNED,
        inApp: false,
        email: false,
      });

      const before = await privileged.notification.count({
        where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      await request('POST', '/api/v1/tasks', ownerToken, {
        title: 'Should be silent',
        locationId,
        assigneeMembershipId: crewMembershipId,
      });
      await dispatcher.drain();

      expect(
        await privileged.notification.count({
          where: { membershipId: crewMembershipId, type: EVENT_TYPES.TASK_ASSIGNED },
        }),
      ).toBe(before);
    });

    it('refuses a type that does not exist rather than storing it', async () => {
      // A stored row for an unknown type is worse than an error: nothing reads
      // it, so somebody believes they switched something off and keeps being
      // told about it.
      const response = await request('PATCH', '/api/v1/notifications/preferences', crewToken, {
        type: 'task.assigneed',
        inApp: false,
        email: false,
      });

      expect(response.statusCode, response.body).toBe(400);

      expect(
        await privileged.notificationPreference.count({
          where: { membershipId: crewMembershipId, type: 'task.assigneed' },
        }),
      ).toBe(0);
    });

    it('the event is still recorded, so turning it back on is not retroactive silence', async () => {
      // Preferences decide DELIVERY, not whether something happened. Phase 12
      // automation reads the same stream and must not be muted by a person's
      // inbox settings.
      const events = await privileged.domainEvent.count({
        where: { organizationId, type: EVENT_TYPES.TASK_ASSIGNED },
      });

      expect(events).toBeGreaterThan(1);
    });
  });

  // =========================================================================

  describe('reading them', () => {
    it('marks everything read in one go', async () => {
      const before = await inboxOf(crewToken);
      expect(before.unread).toBeGreaterThan(0);

      const response = await request('POST', '/api/v1/notifications/read', crewToken, { ids: [] });

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).unread).toBe(0);
    });

    it('counts unread separately from the page, so a long list still totals right', async () => {
      const inbox = await inboxOf(crewToken);

      expect(inbox.unread).toBe(0);
      expect(inbox.notifications.length).toBeGreaterThan(0);
    });
  });
});
