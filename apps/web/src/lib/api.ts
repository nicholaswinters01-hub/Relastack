import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import {
  invitationsResponseSchema,
  modulesResponseSchema,
  locationsResponseSchema,
  organizationMembersResponseSchema,
  customFieldsResponseSchema,
  customerResponseSchema,
  customersResponseSchema,
  organizationResponseSchema,
  plansResponseSchema,
  publicUserSchema,
  subscriptionResponseSchema,
  tagsResponseSchema,
  dashboardResponseSchema,
  notificationsResponseSchema,
  preferencesResponseSchema,
  jobsResponseSchema,
  jobResponseSchema,
  groupsResponseSchema,
  setupProgressSchema,
  tasksResponseSchema,
  taskResponseSchema,
  type CustomerDetail,
  type CustomFieldsResponse,
  type CustomersResponse,
  type InvitationsResponse,
  type LocationsResponse,
  type ModulesResponse,
  type OrganizationMembersResponse,
  type OrganizationResponse,
  type PlansResponse,
  type PublicUser,
  type SubscriptionResponse,
  type TagsResponse,
  type Dashboard,
  type NotificationPreference,
  type NotificationsResponse,
  type Job,
  type MemberGroup,
  type SetupProgress,
  type JobsResponse,
  type Task,
  type TasksResponse,
} from '@platform/shared';
import { API_URL, internalHeaders } from '@/lib/internal-api';

/**
 * Server-side API access.
 *
 * Server Components call the API directly rather than through the /api
 * relay — there is no browser in the loop, so there is no origin to match,
 * and going direct avoids a pointless extra hop. The session cookie has to be
 * forwarded by hand, because a server-side fetch carries no cookie jar.
 */

export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...internalHeaders(await headers()),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
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
const loadCurrentUser = async (): Promise<PublicUser | null> => {
  try {
    const response = await serverFetch('/api/v1/auth/me');
    if (!response.ok) return null;

    const body = await response.json();
    const parsed = publicUserSchema.safeParse(body.user);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Deduplicated for the render pass: the navigation and the page both ask. */
export const getCurrentUser = cache(loadCurrentUser);

/**
 * The caller's organization and their role in it, or null.
 *
 * Null means "not in a business": signed out, no membership, or a suspended
 * organization. Pages send that to the sign-in page.
 *
 * A busy or unreachable API is NOT that. Answering null for a 429 or a 500
 * signed people out mid-task; it throws instead, and the error page offers a
 * retry with the session untouched.
 */
const loadCurrentOrganization = async (): Promise<OrganizationResponse | null> => {
  let response: Response;
  try {
    response = await serverFetch('/api/v1/organizations/current');
  } catch {
    throw new Error('RelaStack could not be reached');
  }

  if (response.status === 429 || response.status >= 500) {
    throw new Error('RelaStack is busy');
  }

  try {
    if (!response.ok) return null;

    const parsed = organizationResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Deduplicated for the render pass.
 *
 * Every signed-in page needs this, and so does the navigation rendered
 * alongside it. Without `cache` that is two identical HTTP calls per page
 * view, growing by one for every component that needs to know who is signed
 * in.
 */
export const getCurrentOrganization = cache(loadCurrentOrganization);

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
const loadModules = async (): Promise<ModulesResponse['modules']> => {
  try {
    const response = await serverFetch('/api/v1/modules');
    if (!response.ok) return [];

    const parsed = modulesResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.modules : [];
  } catch {
    return [];
  }
};

/** Deduplicated for the render pass — see getCurrentOrganization. */
export const getModules = cache(loadModules);

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

/**
 * Customers the caller may see.
 *
 * The server decides which those are. This helper passes the filters through
 * and never narrows anything itself — the browser is not where scoping is
 * enforced, and pretending otherwise is how a filter becomes mistaken for a
 * permission.
 */
export async function getCustomers(
  params: Record<string, string | undefined> = {},
): Promise<CustomersResponse> {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  try {
    const response = await serverFetch(`/api/v1/customers?${query.toString()}`);
    if (!response.ok) return { customers: [], nextCursor: null };

    const parsed = customersResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : { customers: [], nextCursor: null };
  } catch {
    return { customers: [], nextCursor: null };
  }
}

/** One customer with their contacts and notes. Null if out of reach. */
export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  try {
    const response = await serverFetch(`/api/v1/customers/${id}`);
    if (!response.ok) return null;

    const parsed = customerResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.customer : null;
  } catch {
    return null;
  }
}

/** The organization's tag vocabulary. */
export async function getTags(): Promise<TagsResponse['tags']> {
  try {
    const response = await serverFetch('/api/v1/tags');
    if (!response.ok) return [];

    const parsed = tagsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.tags : [];
  } catch {
    return [];
  }
}

/** Custom field definitions. Pass true to include retired ones. */
export async function getCustomFields(
  includeArchived = false,
): Promise<CustomFieldsResponse['fields']> {
  try {
    const response = await serverFetch(
      includeArchived ? '/api/v1/custom-fields/all' : '/api/v1/custom-fields',
    );
    if (!response.ok) return [];

    const parsed = customFieldsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.fields : [];
  } catch {
    return [];
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

/**
 * Tasks the caller may see.
 *
 * Filters are passed through untouched. Which tasks come back, and whether
 * each one names the customer it concerns, are both decided by the server.
 */
export async function getTasks(
  params: Record<string, string | undefined> = {},
): Promise<TasksResponse> {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  try {
    const response = await serverFetch(`/api/v1/tasks?${query.toString()}`);
    if (!response.ok) return { tasks: [], nextCursor: null };

    const parsed = tasksResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : { tasks: [], nextCursor: null };
  } catch {
    return { tasks: [], nextCursor: null };
  }
}

/**
 * Jobs the caller may see, within whatever window is asked for.
 *
 * Which jobs come back, and whether each names the customer it is for, are
 * both decided by the server.
 */
export async function getJobs(
  params: Record<string, string | undefined> = {},
): Promise<JobsResponse> {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  try {
    const response = await serverFetch(`/api/v1/jobs?${query.toString()}`);
    if (!response.ok) return { jobs: [], nextCursor: null };

    const parsed = jobsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : { jobs: [], nextCursor: null };
  } catch {
    return { jobs: [], nextCursor: null };
  }
}

/**
 * The dashboard figures.
 *
 * Already narrowed by the server to what this reader may see — the response
 * carries a `scope` saying whether that is the whole company or some branches.
 */
export async function getDashboard(
  params: Record<string, string | undefined> = {},
): Promise<Dashboard | null> {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  try {
    const response = await serverFetch(`/api/v1/reports/dashboard?${query.toString()}`);
    if (!response.ok) return null;

    const parsed = dashboardResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.dashboard : null;
  } catch {
    return null;
  }
}

/** The caller's own notifications. Never anybody else's — there is no ask. */
export async function getNotifications(): Promise<NotificationsResponse> {
  try {
    const response = await serverFetch('/api/v1/notifications?limit=20');
    if (!response.ok) return { notifications: [], unread: 0 };

    const parsed = notificationsResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : { notifications: [], unread: 0 };
  } catch {
    return { notifications: [], unread: 0 };
  }
}

/** The caller's own notification preferences, defaults included. */
export async function getNotificationPreferences(): Promise<NotificationPreference[]> {
  try {
    const response = await serverFetch('/api/v1/notifications/preferences');
    if (!response.ok) return [];

    const parsed = preferencesResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.preferences : [];
  } catch {
    return [];
  }
}

/** One job, or null when it does not exist or the reader may not see it. */
export async function getJob(id: string): Promise<Job | null> {
  try {
    const response = await serverFetch(`/api/v1/jobs/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const parsed = jobResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.job : null;
  } catch {
    return null;
  }
}

/** One task, or null when it does not exist or the reader may not see it. */
export async function getTask(id: string): Promise<Task | null> {
  try {
    const response = await serverFetch(`/api/v1/tasks/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const parsed = taskResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.task : null;
  } catch {
    return null;
  }
}

/** The business's employee groups, or none when the caller may not see the Employees page. */
export async function getGroups(): Promise<MemberGroup[]> {
  try {
    const response = await serverFetch('/api/v1/groups');
    if (!response.ok) return [];
    const parsed = groupsResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.groups : [];
  } catch {
    return [];
  }
}

/** The "Get started" checklist, or null for anyone who does not run the business. */
export async function getSetupProgress(): Promise<SetupProgress | null> {
  try {
    const response = await serverFetch('/api/v1/organizations/current/setup');
    if (!response.ok) return null;
    const parsed = setupProgressSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
