import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { EVENT_TYPES, type EventType } from '@platform/shared';
import { SERVER_ENV } from '../config.provider';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';

/** How a handler describes the message it wants delivered. */
interface Delivery {
  membershipId: string;
  title: string;
  body: string;
  linkPath?: string;
}

const MAX_ATTEMPTS = 5;

/**
 * Drains the outbox.
 *
 * Turns events into notifications, and notifications into email. Runs out of
 * band rather than in the request that caused the event, so a slow provider
 * never makes somebody wait to save a task.
 *
 * Prompted, not polled. Each recorded event nudges a drain moments later, and
 * the hourly sweep drains whatever a nudge missed. A short poll would keep the
 * database awake around the clock; hosted Postgres that sleeps when idle
 * (Neon) is only free if it is actually left idle.
 *
 * **Single instance.** Two copies of the API would both claim the same events.
 * Delivery is idempotent — the unique pair on (event, membership) refuses a
 * duplicate notification and `emailedAt` refuses a duplicate email — so the
 * result would be correct rather than doubled, but the work would be done
 * twice. A claim with `FOR UPDATE SKIP LOCKED` is what this needs before
 * running more than one process, and it is not here yet.
 */
@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private running = false;
  /** A drain was asked for while one was running; run again when it finishes. */
  private again = false;
  private soon: NodeJS.Timeout | null = null;
  private soonRequestedAt = 0;
  private later: NodeJS.Timeout | null = null;
  private startup: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  private get enabled(): boolean {
    // Zero disables all background delivery. The e2e suite drains by hand so a
    // timer can never race an assertion.
    return this.env.DISPATCH_INTERVAL_SECONDS !== 0;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Dispatcher disabled (DISPATCH_INTERVAL_SECONDS=0)');
      return;
    }

    // Anything left undelivered by a crash or a redeploy goes out at startup
    // rather than waiting for the first hourly sweep.
    // Its own timer: sharing the quick-delivery slot made every event in the
    // first five seconds wait for this instead.
    this.startup = this.schedule(5_000, () => (this.startup = null));
  }

  onModuleDestroy(): void {
    for (const timer of [this.soon, this.later, this.startup]) {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * An event was just recorded: deliver it shortly.
   *
   * Called from inside the transaction that wrote the event, so a drain run
   * right now would not see it — the row is not committed yet. Two passes
   * cover that: one a second later, postponed by further activity for at
   * most five seconds, and one fifteen seconds after the last nudge for a
   * slow commit. Anything slower still is picked up by the hourly sweep.
   */
  nudge(): void {
    if (!this.enabled) return;

    const now = Date.now();
    if (!this.soon) this.soonRequestedAt = now;

    if (!this.soon || now - this.soonRequestedAt < 5_000) {
      if (this.soon) clearTimeout(this.soon);
      this.soon = this.schedule(1_000, () => (this.soon = null));
    }

    if (this.later) clearTimeout(this.later);
    this.later = this.schedule(15_000, () => (this.later = null));
  }

  private schedule(delay: number, onFire: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      onFire();
      void this.drain().catch((error) => this.logger.error('Dispatch failed', error));
    }, delay);

    // Never hold the process open on our account.
    timer.unref?.();
    return timer;
  }

  /**
   * Process pending events, oldest first.
   *
   * Guarded against overlapping runs: a slow batch must not have a second
   * timer tick start alongside it and process the same rows twice.
   */
  async drain(limit = 50): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;

    try {
      /*
       * Read through the platform-worker hatch, not the bare client.
       *
       * An outbox serving one tenant is not an outbox, so there is no single
       * organization to set — and running with none returns NOTHING, because
       * the policies fail closed. That is rule 3 working, and it caught this
       * exact code returning an empty queue forever.
       *
       * The hatch is read-only in spirit and covers three tables. Every write
       * below still goes through withTenant for one organization at a time.
       */
      const pending = await this.prisma.withPlatformWorker((tx) =>
        tx.domainEvent.findMany({
          where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
          orderBy: { createdAt: 'asc' },
          take: limit,
        }),
      );

      let handled = 0;

      for (const event of pending) {
        try {
          await this.handle(event.id, event.organizationId, event.type as EventType, event.payload);

          await this.prisma.withPlatformWorker((tx) =>
            tx.domainEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } }),
          );

          handled += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          // Counted, not swallowed. After MAX_ATTEMPTS it stops being retried
          // and stays in the table as a record of what failed and why, rather
          // than disappearing or blocking everything behind it.
          await this.prisma.withPlatformWorker((tx) =>
            tx.domainEvent.update({
              where: { id: event.id },
              data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
            }),
          );

          this.logger.warn(`Event ${event.id} (${event.type}) failed: ${message}`);
        }
      }

      return handled;
    } finally {
      this.running = false;

      // Events recorded mid-drain may have been committed after the read.
      if (this.again) {
        this.again = false;
        if (!this.soon) {
          this.soonRequestedAt = Date.now();
          this.soon = this.schedule(0, () => (this.soon = null));
        }
      }
    }
  }

  // -------------------------------------------------------------------------

  private async handle(
    eventId: string,
    organizationId: string,
    type: EventType,
    payload: unknown,
  ): Promise<void> {
    const data = (payload ?? {}) as Record<string, string | undefined>;

    const deliveries = await this.deliveriesFor(organizationId, type, data);

    for (const delivery of deliveries) {
      await this.deliver(eventId, organizationId, type, delivery);
    }
  }

  /** Who should hear about this, and what it should say. */
  private async deliveriesFor(
    organizationId: string,
    type: EventType,
    data: Record<string, string | undefined>,
  ): Promise<Delivery[]> {
    switch (type) {
      case EVENT_TYPES.TASK_ASSIGNED:
        return data.assigneeMembershipId
          ? [
              {
                membershipId: data.assigneeMembershipId,
                title: 'A task was assigned to you',
                body: data.title ?? 'You have a new task.',
                linkPath: '/tasks?filter=mine',
              },
            ]
          : [];

      case EVENT_TYPES.JOB_ASSIGNED:
        return (data.membershipIds ?? '')
          .split(',')
          .filter(Boolean)
          .map((membershipId) => ({
            membershipId,
            title: 'You were added to a job',
            body: `${data.title ?? 'A job'}${data.when ? ` — ${data.when}` : ''}`,
            linkPath: data.day ? `/schedule?day=${data.day}` : '/schedule',
          }));

      case EVENT_TYPES.JOB_CHANGED:
      case EVENT_TYPES.JOB_CANCELLED:
        return (data.membershipIds ?? '')
          .split(',')
          .filter(Boolean)
          .map((membershipId) => ({
            membershipId,
            title:
              type === EVENT_TYPES.JOB_CANCELLED ? 'A job was cancelled' : 'A job you are on moved',
            body: `${data.title ?? 'A job'}${data.when ? ` — now ${data.when}` : ''}`,
            linkPath: data.day ? `/schedule?day=${data.day}` : '/schedule',
          }));

      case EVENT_TYPES.SUBSCRIPTION_PAST_DUE:
      case EVENT_TYPES.SUBSCRIPTION_READ_ONLY: {
        // Money reaches whoever can actually do something about it. Read in
        // the event's own tenant context: membership_role is not in the worker
        // hatch, and should not be.
        const owners = await this.prisma.withTenant(systemContext(organizationId), (tx) =>
          tx.membershipRole.findMany({
            where: { scope: 'ORGANIZATION', role: { key: 'org_admin' } },
            select: { membershipId: true },
          }),
        );

        const pastDue = type === EVENT_TYPES.SUBSCRIPTION_PAST_DUE;

        return owners.map((owner) => ({
          membershipId: owner.membershipId,
          title: pastDue ? 'A payment did not go through' : 'Your account is now read-only',
          body: pastDue
            ? 'Nothing has changed yet — you keep full access while we retry. Update your billing details to avoid interruption.'
            : 'Your subscription is not active, so changes are paused. Everything is still here and still exportable.',
          linkPath: '/billing',
        }));
      }

      // Invitations are emailed directly by their own service, because the
      // recipient has no membership to address a notification to yet.
      case EVENT_TYPES.INVITATION_SENT:
        return [];
    }
  }

  /**
   * Create the notification, then email it if wanted.
   *
   * Both halves are idempotent. The unique pair on (event, membership) means a
   * retry after a half-finished run is refused rather than duplicated, and
   * `emailedAt` stops a second message going out for a notification that was
   * already delivered.
   */
  private async deliver(
    eventId: string,
    organizationId: string,
    type: EventType,
    delivery: Delivery,
  ): Promise<void> {
    /*
     * Everything here runs in the EVENT'S tenant context, one organization at
     * a time. Preferences, notifications and memberships are not in the worker
     * hatch and must not be: a bug that reached across a boundary here would
     * tell somebody in one company what happened in another.
     */
    const context = systemContext(organizationId);

    const { notification, wantsEmail, email } = await this.prisma.withTenant(
      context,
      async (tx) => {
        const preference = await tx.notificationPreference.findUnique({
          where: { membershipId_type: { membershipId: delivery.membershipId, type } },
        });

        // Absent means the default, which is on. Only exceptions are stored.
        const inApp = preference?.inApp ?? true;
        const byEmail = preference?.email ?? true;

        if (!inApp && !byEmail) return { notification: null, wantsEmail: false, email: null };

        const existing = await tx.notification.findUnique({
          where: { eventId_membershipId: { eventId, membershipId: delivery.membershipId } },
        });

        const row =
          existing ??
          (await tx.notification.create({
            data: {
              organizationId,
              membershipId: delivery.membershipId,
              type,
              title: delivery.title,
              body: delivery.body,
              linkPath: delivery.linkPath ?? null,
              eventId,
              // Suppressed in-app but wanted by email: marked read on arrival
              // so the bell stays honest while the message still goes out.
              readAt: inApp ? null : new Date(),
            },
          }));

        const member = await tx.organizationMembership.findUnique({
          where: { id: delivery.membershipId },
          select: { user: { select: { email: true } } },
        });

        return {
          notification: row,
          wantsEmail: byEmail && row.emailedAt === null,
          email: member?.user.email ?? null,
        };
      },
    );

    if (!notification || !wantsEmail || !email) return;

    // Sent outside the transaction on purpose: a provider taking three seconds
    // must not hold a database transaction open for three seconds. A failure
    // here throws, the event retries, and `emailedAt` keeps the retry from
    // sending twice.
    await this.email.send({
      to: email,
      subject: delivery.title,
      body: delivery.body,
      link: delivery.linkPath ? `${this.env.APP_URL}${delivery.linkPath}` : undefined,
    });

    await this.prisma.withTenant(context, (tx) =>
      tx.notification.update({ where: { id: notification.id }, data: { emailedAt: new Date() } }),
    );
  }
}

/**
 * Tenant context for work the platform performs on its own behalf.
 *
 * The nil UUID stands in for "no person did this". It is only ever used to
 * satisfy the tenant helper, never to attribute anything — every row a worker
 * writes carries its real author, or none.
 */
function systemContext(organizationId: string): { organizationId: string; userId: string } {
  return { organizationId, userId: '00000000-0000-0000-0000-000000000000' };
}
