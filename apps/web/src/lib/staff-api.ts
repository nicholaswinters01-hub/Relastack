import { cache } from 'react';
import {
  staffAuditResponseSchema,
  staffBusinessDetailSchema,
  staffBusinessesResponseSchema,
  staffOverviewSchema,
  type StaffAuditEvent,
  type StaffBusinessDetail,
  type StaffBusinessSummary,
  type StaffOverview,
} from '@platform/shared';
import { serverFetch } from '@/lib/api';

/**
 * The staff console's reads.
 *
 * Whether someone is staff is the API's decision, made against the database on
 * every request. These only ask; a null answer means "not staff, or not
 * reachable", and the pages treat both as "show nothing".
 */

async function read<T>(path: string, parse: (body: unknown) => T | null): Promise<T | null> {
  try {
    const response = await serverFetch(path);
    if (!response.ok) return null;
    return parse(await response.json());
  } catch {
    return null;
  }
}

/** The signed-in person's staff identity, or null. Cached per render: the nav and the page both ask. */
export const getStaffIdentity = cache(() =>
  read('/api/v1/staff/me', (body) => {
    const email = (body as { email?: unknown }).email;
    return typeof email === 'string' ? { email } : null;
  }),
);

export function getStaffOverview(): Promise<StaffOverview | null> {
  return read('/api/v1/staff/overview', (body) => {
    const parsed = staffOverviewSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

export async function getStaffBusinesses(query: {
  search?: string;
  filter?: string;
}): Promise<StaffBusinessSummary[] | null> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.filter) params.set('filter', query.filter);

  return read(`/api/v1/staff/businesses?${params.toString()}`, (body) => {
    const parsed = staffBusinessesResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.businesses : null;
  });
}

export function getStaffBusiness(id: string): Promise<StaffBusinessDetail | null> {
  return read(`/api/v1/staff/businesses/${encodeURIComponent(id)}`, (body) => {
    const parsed = staffBusinessDetailSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

export async function getStaffAudit(): Promise<StaffAuditEvent[] | null> {
  return read('/api/v1/staff/audit', (body) => {
    const parsed = staffAuditResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.events : null;
  });
}
