import { NotFoundException } from '@nestjs/common';
import type { TransactionClient } from '@platform/db';
import { PERMISSIONS } from '@platform/shared';
import type { PermissionSet } from '../rbac/permission-set';

export interface JobAccess {
  job: {
    id: string;
    locationId: string | null;
    vehicleId: string | null;
    seriesId: string | null;
    detachedFromSeries: boolean;
  };
  onCrew: boolean;
  /** May book jobs at its branch. */
  canWrite: boolean;
  /** On the crew, or may book it: may record what was done on it. */
  canRecordWork: boolean;
}

/**
 * A job the reader may see, and what they may do on it; 404 otherwise.
 *
 * The same rule as the schedule: visible organization-wide, at a branch where
 * they hold job.read, or because they are on the crew. Whoever is on the crew
 * may record the work done, authority from the row, like completing it.
 */
export async function loadJobAccess(
  tx: TransactionClient,
  permissions: PermissionSet,
  membershipId: string,
  jobId: string,
): Promise<JobAccess> {
  const job = await tx.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      locationId: true,
      vehicleId: true,
      seriesId: true,
      detachedFromSeries: true,
      assignments: { select: { membershipId: true } },
    },
  });
  if (!job) throw new NotFoundException('Job not found');

  const onCrew = job.assignments.some((entry) => entry.membershipId === membershipId);
  const at = (permission: typeof PERMISSIONS.JOB_READ | typeof PERMISSIONS.JOB_WRITE) =>
    job.locationId === null
      ? permissions.has(permission)
      : permissions.hasAt(permission, job.locationId);

  if (!onCrew && !at(PERMISSIONS.JOB_READ)) throw new NotFoundException('Job not found');

  const canWrite = at(PERMISSIONS.JOB_WRITE);
  return {
    job: {
      id: job.id,
      locationId: job.locationId,
      vehicleId: job.vehicleId,
      seriesId: job.seriesId,
      detachedFromSeries: job.detachedFromSeries,
    },
    onCrew,
    canWrite,
    canRecordWork: onCrew || canWrite,
  };
}
