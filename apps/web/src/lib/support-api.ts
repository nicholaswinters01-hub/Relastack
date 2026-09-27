import {
  staffSupportDetailSchema,
  staffSupportListSchema,
  supportRequestDetailSchema,
  supportRequestsResponseSchema,
  type StaffSupportDetail,
  type StaffSupportSummary,
  type SupportRequestDetail,
  type SupportRequestSummary,
} from '@platform/shared';
import { serverFetch } from '@/lib/api';

/** The help desk's reads. Null means not found, not allowed, or not reachable. */
async function read<T>(
  path: string,
  parse: (body: unknown) => { success: boolean; data?: T },
): Promise<T | null> {
  try {
    const response = await serverFetch(path);
    if (!response.ok) return null;
    const parsed = parse(await response.json());
    return parsed.success ? (parsed.data ?? null) : null;
  } catch {
    return null;
  }
}

export async function getSupportRequests(): Promise<SupportRequestSummary[] | null> {
  const body = await read('/api/v1/support/requests', (b) =>
    supportRequestsResponseSchema.safeParse(b),
  );
  return body?.requests ?? null;
}

export function getSupportRequest(id: string): Promise<SupportRequestDetail | null> {
  return read(`/api/v1/support/requests/${encodeURIComponent(id)}`, (b) =>
    supportRequestDetailSchema.safeParse(b),
  );
}

export async function getStaffSupport(filter: string): Promise<StaffSupportSummary[] | null> {
  const body = await read(`/api/v1/staff/support?filter=${encodeURIComponent(filter)}`, (b) =>
    staffSupportListSchema.safeParse(b),
  );
  return body?.requests ?? null;
}

export function getStaffSupportRequest(id: string): Promise<StaffSupportDetail | null> {
  return read(`/api/v1/staff/support/${encodeURIComponent(id)}`, (b) =>
    staffSupportDetailSchema.safeParse(b),
  );
}
