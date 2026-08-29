import { cookies } from 'next/headers';
import {
  invitationsResponseSchema,
  modulesResponseSchema,
  locationsResponseSchema,
  organizationMembersResponseSchema,
  organizationResponseSchema,
  plansResponseSchema,
  publicUserSchema,
  subscriptionResponseSchema,
  type InvitationsResponse,
  type LocationsResponse,
  type ModulesResponse,
  type OrganizationMembersResponse,
  type OrganizationResponse,
  type PlansResponse,
  type PublicUser,
  type SubscriptionResponse,
} from '@platform/shared';

/**
 * Server-side API access.
 *
 * Server Components call the API directly rather than through the Next.js
 * rewrite — there is no browser in the loop, so there is no origin to match,
 * and going direct avoids a pointless extra hop. The session cookie has to be
 * forwarded by hand, because a server-side fetch carries no cookie jar.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...init.headers, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    cache: 'no-store',
  });
}

/**
 * The signed-in user, or null.
 *
 * Returns null rather than throwing for any failure — not signed in, expired
 * session, API unreachable. Callers decide what to do about it, and a page
 * that merely wants to know "is someone logged in" should not have to
 * distinguish those cases.
 */
export async function getCurrentUser(): Promise<PublicUser | null> {
  try {
    const response = await serverFetch('/api/v1/auth/me');
    if (!response.ok) return null;

    const body = await response.json();
    const parsed = publicUserSchema.safeParse(body.user);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The caller's organization and their role in it, or null.
 *
 * Null covers every failure the same way — signed out, no membership,
 * suspended organization, API unreachable. The page decides what to show; it
 * should not have to distinguish causes it cannot act on.
 */
export async function getCurrentOrganization(): Promise<OrganizationResponse | null> {
  try {
    const response = await serverFetch('/api/v1/organizations/current');
    if (!response.ok) return null;

    const parsed = organizationResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Locations the caller can see. Empty on any failure — the page decides. */
export async function getLocations(): Promise<LocationsResponse['locations']> {
  try {
    const response = await serverFetch('/api/v1/locations');
    if (!response.ok) return [];

    const parsed = locationsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.locations : [];
  } catch {
    return [];
  }
}

/** Members of the caller's organization, for the assignment picker. */
export async function getOrganizationMembers(): Promise<OrganizationMembersResponse['members']> {
  try {
    const response = await serverFetch('/api/v1/organizations/current/members');
    if (!response.ok) return [];

    const parsed = organizationMembersResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.members : [];
  } catch {
    return [];
  }
}

/** Pending invitations for the caller's organization. */
export async function getInvitations(): Promise<InvitationsResponse['invitations']> {
  try {
    const response = await serverFetch('/api/v1/invitations');
    if (!response.ok) return [];

    const parsed = invitationsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.invitations : [];
  } catch {
    return [];
  }
}

/** Every module, with this organization's enabled state. */
export async function getModules(): Promise<ModulesResponse['modules']> {
  try {
    const response = await serverFetch('/api/v1/modules');
    if (!response.ok) return [];

    const parsed = modulesResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.modules : [];
  } catch {
    return [];
  }
}

/**
 * The organization's subscription and what it will be charged.
 *
 * The billing page has to render for a lapsed organization — that is exactly
 * when someone needs it — so nothing here may depend on a capability that a
 * lapse turns off.
 */
export async function getSubscription(): Promise<SubscriptionResponse | null> {
  try {
    const response = await serverFetch('/api/v1/billing/subscription');
    if (!response.ok) return null;

    const parsed = subscriptionResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The public price list. */
export async function getPlans(): Promise<PlansResponse['plans']> {
  try {
    const response = await serverFetch('/api/v1/billing/plans');
    if (!response.ok) return [];

    const parsed = plansResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.plans : [];
  } catch {
    return [];
  }
}
