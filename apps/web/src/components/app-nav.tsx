import Link from 'next/link';
import { MODULES, PERMISSIONS, type ModuleState, type PermissionKey } from '@platform/shared';
import { NotificationBell } from '@/components/notification-bell';
import { getCurrentOrganization, getModules, getNotifications } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

/**
 * The application's navigation.
 *
 * Replaces the ad-hoc footer links each page used to carry, which drifted out
 * of step immediately: the customer screens shipped in Phase 7 and nothing
 * linked to them, so the only way to reach them was typing the URL.
 *
 * What appears here is a function of two separate questions, and they are
 * genuinely different:
 *
 *   entitlement — is this module switched on for the organization?
 *   permission  — may THIS person see it?
 *
 * A Location Manager at a company with the CRM enabled sees Customers; an
 * employee without customer.read does not, even though the module is on.
 *
 * None of this is access control. Hiding a link is a courtesy so people are
 * not offered doors that will not open — the API refuses the request whatever
 * the browser chooses to render, and the e2e suite proves it.
 */

interface Entry {
  href: string;
  label: string;
  permission: PermissionKey;
  /** Only shown when this module is enabled. Core links leave it undefined. */
  module?: string;
}

const ENTRIES: Entry[] = [
  {
    href: '/',
    label: 'Dashboard',
    permission: PERMISSIONS.ORGANIZATION_READ,
    module: MODULES.REPORTING,
  },
  {
    href: '/customers',
    label: 'Customers',
    permission: PERMISSIONS.CUSTOMER_READ,
    module: MODULES.CRM,
  },
  {
    href: '/schedule',
    label: 'Schedule',
    permission: PERMISSIONS.JOB_READ,
    module: MODULES.SCHEDULING,
  },
  // Core, so no module gate — tasks are on every plan.
  { href: '/tasks', label: 'Tasks', permission: PERMISSIONS.TASK_READ },
  { href: '/locations', label: 'Locations', permission: PERMISSIONS.LOCATION_READ },
  { href: '/team', label: 'Team', permission: PERMISSIONS.MEMBER_READ },
  { href: '/modules', label: 'Modules', permission: PERMISSIONS.ORGANIZATION_READ },
  { href: '/billing', label: 'Billing', permission: PERMISSIONS.ORGANIZATION_READ },
];

export async function AppNav({ current }: { current: string }) {
  const organization = await getCurrentOrganization();

  if (!organization) return null;

  const [modules, inbox] = await Promise.all([getModules(), getNotifications()]);
  const enabled = new Set(
    modules.filter((module: ModuleState) => module.enabled).map((module) => module.key),
  );

  const visible = ENTRIES.filter(
    (entry) =>
      (entry.module === undefined || enabled.has(entry.module)) &&
      canAnywhere(organization.permissions, entry.permission),
  );

  return (
    <nav className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-1 gap-y-2 px-6 py-3">
        <Link
          href="/account"
          className="mr-3 font-semibold tracking-tight"
          aria-current={current === 'account' ? 'page' : undefined}
        >
          {organization.organization.name}
        </Link>

        {visible.map((entry) => {
          const active = current === entry.label.toLowerCase();

          return (
            <Link
              key={entry.href}
              href={entry.href}
              aria-current={active ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                active
                  ? 'bg-[var(--color-canvas)] font-medium'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {entry.label}
            </Link>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          <NotificationBell notifications={inbox.notifications} unread={inbox.unread} />
        </div>

        <Link
          href="/account"
          aria-current={current === 'account' ? 'page' : undefined}
          className={`rounded-lg px-3 py-1.5 text-sm ${
            current === 'account'
              ? 'bg-[var(--color-canvas)] font-medium'
              : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
          }`}
        >
          Account
        </Link>
      </div>
    </nav>
  );
}
