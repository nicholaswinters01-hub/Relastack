import { Logger } from '@nestjs/common';
import type { Prisma, TransactionClient } from '@platform/db';
import type { StaffAuditEvent } from '@platform/shared';
import type { StaffIdentity } from './staff.decorators';

const logger = new Logger('StaffAudit');

/**
 * Write one entry to the staff audit trail.
 *
 * Takes the transaction making the change, so there is never a change without
 * its record, nor a record of a change that rolled back.
 */
export async function recordStaffEvent(
  tx: TransactionClient,
  staff: StaffIdentity,
  organizationId: string | null,
  action: string,
  reason: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.staffAuditEvent.create({
    data: {
      staffUserId: staff.userId,
      staffEmail: staff.email,
      organizationId,
      action,
      reason,
      details: details as Prisma.InputJsonValue,
    },
  });

  if (reason !== null) {
    logger.log(`${staff.email} ${action} on ${organizationId ?? 'platform'}: ${reason}`);
  }
}

export function toAuditEvent(event: {
  id: string;
  staffEmail: string;
  organizationId: string | null;
  action: string;
  reason: string | null;
  details: Prisma.JsonValue;
  createdAt: Date;
}): StaffAuditEvent {
  return {
    id: event.id,
    staffEmail: event.staffEmail,
    organizationId: event.organizationId,
    action: event.action,
    reason: event.reason,
    details:
      event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : {},
    createdAt: event.createdAt.toISOString(),
  };
}
