import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { EVENT_TYPES } from '@platform/shared';
import { SERVER_ENV } from '../config.provider';
import { PrismaService } from '../prisma/prisma.service';
import { JobSeriesService } from '../scheduling/job-series.service';

/** How often the periodic work runs. Hourly is ample for both jobs below. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The work that has to happen on a clock rather than in a request.
 *
 * Two things, both of which have been listed as known limitations since the
 * phases that created them:
 *
 *   - a lapsed subscription is only computed on read, so nothing ever
 *     *changes* and there is no moment to notify anybody about
 *   - a recurring series only extends its horizon when somebody edits it, so
 *     one left alone eventually stops producing visits
 *
 * **Single instance.** Two copies of the API would both run these. The work is
 * idempotent — materialisation is guarded by a unique index, and the status
 * write is conditional — so the result would be correct rather than doubled,
 * but it would be wasteful and worth a lock before scaling out.
 */
@Injectable()
export class SweepsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SweepsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly series: JobSeriesService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  onModuleInit(): void {
    // Shares the dispatcher's off switch, so a test run has no background
    // timers at all racing its assertions.
    if (this.env.DISPATCH_INTERVAL_SECONDS === 0) return;

    this.timer = setInterval(() => {
      void this.run().catch((error) => this.logger.error('Sweep failed', error));
    }, SWEEP_INTERVAL_MS);

    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<{ lapsed: number; booked: number }> {
    if (this.running) return { lapsed: 0, booked: 0 };
    this.running = true;

    try {
      return { lapsed: await this.lapseSubscriptions(), booked: await this.extendSeries() };
    } finally {
      this.running = false;
    }
  }

  /**
   * Persist what `effectiveStatus` already computes on read.
   *
   * Billing has always narrowed access correctly the moment a grace period
   * expires, because it works it out per request. What it could not do was
   * *notice* — there was no state change, so there was nothing to tell the
   * owner about. This makes the change real, once, and emits the event.
   *
   * Conditional on the current status, so running twice notifies once.
   */
  private async lapseSubscriptions(): Promise<number> {
    const now = new Date();

    // Through the hatch: a sweep that only sees one tenant is not a sweep,
    // and the bare client sees nothing at all.
    const due = await this.prisma.withPlatformWorker((tx) =>
      tx.subscription.findMany({
        where: {
          OR: [
            { status: 'PAST_DUE', graceEndsAt: { lte: now } },
            { status: 'TRIALING', trialEndsAt: { lte: now } },
          ],
        },
        select: { id: true, organizationId: true },
      }),
    );

    for (const subscription of due) {
      await this.prisma.withPlatformWorker(async (tx) => {
        const updated = await tx.subscription.updateMany({
          // Re-checked inside the transaction: another instance, or the
          // customer paying in the meantime, must not be overwritten.
          where: {
            id: subscription.id,
            OR: [
              { status: 'PAST_DUE', graceEndsAt: { lte: now } },
              { status: 'TRIALING', trialEndsAt: { lte: now } },
            ],
          },
          data: { status: 'SUSPENDED' },
        });

        if (updated.count === 0) return;

        await tx.domainEvent.create({
          data: {
            organizationId: subscription.organizationId,
            type: EVENT_TYPES.SUBSCRIPTION_READ_ONLY,
            payload: { reason: 'grace_expired' },
          },
        });
      });
    }

    if (due.length > 0) this.logger.log(`Lapsed ${due.length} subscription(s)`);

    return due.length;
  }

  /**
   * Keep every live series booked out to its horizon.
   *
   * Without this a series stops producing once the 90 days it was created with
   * run out, which looks exactly like the software forgetting about a customer
   * on a contract.
   */
  private async extendSeries(): Promise<number> {
    const organizations = await this.prisma.withPlatformWorker((tx) =>
      tx.jobSeries.findMany({
        where: { active: true },
        select: { organizationId: true },
        distinct: ['organizationId'],
      }),
    );

    let booked = 0;

    for (const { organizationId } of organizations) {
      // A tenant context with no user: this is the platform acting, not a
      // person, and the series service scopes every write to the organization.
      booked += await this.series.topUp({
        organizationId,
        userId: '00000000-0000-4000-a000-000000000000',
      });
    }

    if (booked > 0) this.logger.log(`Booked ${booked} recurring visit(s)`);

    return booked;
  }
}
