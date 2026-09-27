import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext, TransactionClient } from '@platform/db';
import type { EventType } from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DispatcherService } from './dispatcher.service';

/**
 * Recording that something happened.
 *
 * A transactional outbox. The event is written with the SAME transaction
 * client as the change that caused it, so the two commit together or not at
 * all. An in-memory emitter would drop the event if the process died in
 * between, and nobody would ever learn they had been given work — a failure
 * with no trace and no error.
 *
 * Handlers run later, out of band, so a slow email never delays the request
 * that caused it.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: DispatcherService,
  ) {}

  /**
   * Record an event inside a caller's transaction.
   *
   * Takes the transaction client rather than opening its own, which is the
   * whole point: a second transaction could commit while the first rolls back,
   * leaving an event describing something that never happened.
   */
  async emit(
    tx: TransactionClient,
    organizationId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.domainEvent.create({
      data: { organizationId, type, payload: payload as never },
    });

    this.dispatcher.nudge();
  }

  /**
   * Record an event on its own.
   *
   * For callers that have already committed and cannot join a transaction.
   * Slightly weaker — the change could commit and this fail — so it is used
   * only where the event is a notification rather than a fact anything relies
   * on.
   */
  async emitStandalone(
    context: TenantContext,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.withTenant(context, (tx) =>
      this.emit(tx, context.organizationId, type, payload),
    );
  }

  /** Recent events for one organization. Used by the tests and, later, an audit view. */
  async recent(context: TenantContext, limit = 50) {
    return this.prisma.withTenant(context, (tx) =>
      tx.domainEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
    );
  }
}
