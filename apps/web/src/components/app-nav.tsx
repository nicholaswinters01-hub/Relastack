import Link from 'next/link';
import { MODULES, PERMISSIONS, type ModuleState, type PermissionKey } from '@platform/shared';
import { NotificationBell } from '@/components/notification-bell';
import { getCurrentOrganization, getCurrentUser, getModules, getNotifications } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';
import { getStaffIdentity } from '@/lib/staff-api';
import { AccountMenu, type MenuLink } from './account-menu';
import { CommandPalette, type PaletteAction } from './command-palette';
import { LiveSync } from './live-sync';

/**
 * The application's navigation.
 *
 * Work on the left: the modules a business works in. On the right, tools and
 * the person: search, notifications, help, and a menu under their name for
 * everything about the account and the business.
 *
 * What appears is a function of two separate questions:
 *
 *   entitlement — is this module switched on for the organization?
 *   permission  — may THIS person see it?
 *
 * None of this is access control. Hiding a link is a courtesy so people are
 * not offered doors that will not open — the API refuses the request whatever
 * the browser chooses to render, and the e2e suite proves it.
 */

interface Entry {
  href: string;
  label: string;
  permission?: PermissionKey;
  /** Only shown when this module is enabled. Core links leave it undefined. */
  module?: string;
}

/** The work. Industry packs join this list as they arrive. */
const WORK: Entry[] = [
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
  {
    href: '/inventory',
    label: 'Inventory',
    permission: PERMISSIONS.INVENTORY_READ,
    module: MODULES.INVENTORY,
  },
  {
    href: '/fleet',
    label: 'Fleet',
    permission: PERMISSIONS.FLEET_READ,
    module: MODULES.FLEET,
  },
  // Core, so no module gate — tasks are on every plan.
  { href: '/tasks', label: 'Tasks', permission: PERMISSIONS.TASK_READ },
];

/** The account and the business, under the person's name. */
const ACCOUNT: Entry[] = [
  { href: '/account', label: 'Your account' },
  { href: '/locations', label: 'Locations', permission: PERMISSIONS.LOCATION_READ },
  { href: '/employees', label: 'Employees', permission: PERMISSIONS.MEMBER_READ },
  { href: '/modules', label: 'Modules', permission: PERMISSIONS.ORGANIZATION_READ },
  { href: '/billing', label: 'Billing', permission: PERMISSIONS.ORGANIZATION_READ },
];

export async function AppNav({ current }: { current: string }) {
  const organization = await getCurrentOrganization();

  if (!organization) return null;

  const [modules, inbox, staff, user] = await Promise.all([
    getModules(),
    getNotifications(),
    getStaffIdentity(),
    getCurrentUser(),
  ]);
  const enabled = new Set(
    modules.filter((module: ModuleState) => module.enabled).map((module) => module.key),
  );

  const allowed = (entry: Entry) =>
    (entry.module === undefined || enabled.has(entry.module)) &&
    (entry.permission === undefined || canAnywhere(organization.permissions, entry.permission));

  const work = WORK.filter(allowed);
  const account: MenuLink[] = [
    ...ACCOUNT.filter(allowed),
    // Shown only to staff, but not what protects the console: the API
    // answers 404 to everyone else whatever this renders.
    ...(staff ? [{ href: '/staff', label: 'Staff console' }] : []),
  ];

  // What quick search offers before anything is typed. The same doors as the
  // navigation, plus the forms people open most.
  const actions: PaletteAction[] = [
    ...work.map((entry) => ({ label: entry.label, href: entry.href })),
    ...(enabled.has(MODULES.CRM) &&
    canAnywhere(organization.permissions, PERMISSIONS.CUSTOMER_WRITE)
      ? [{ label: 'New customer', href: '/customers?new=1' }]
      : []),
    ...(canAnywhere(organization.permissions, PERMISSIONS.TASK_WRITE)
      ? [{ label: 'New task', href: '/tasks?new=1' }]
      : []),
    { label: 'Ask for help', href: '/help' },
    ...account.map((entry) => ({ label: entry.label, href: entry.href })),
  ];

  const name =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Account';

  const tab = (href: string, label: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm ${
        active
          ? 'bg-[var(--color-canvas)] font-medium'
          : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <nav className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <LiveSync />
      <div className="mx-auto flex max-w-screen-2xl items-center gap-x-1 gap-y-2 px-6 py-3">
        <Link href="/" className="mr-3 truncate font-semibold tracking-tight">
          {organization.organization.name}
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {work.map((entry) => tab(entry.href, entry.label, current === entry.label.toLowerCase()))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <CommandPalette actions={actions} />
          <NotificationBell notifications={inbox.notifications} unread={inbox.unread} />
          {tab('/help', 'Help', current === 'help')}
          <AccountMenu
            name={name}
            email={user?.email ?? ''}
            items={account}
            workItems={work.map((entry) => ({ href: entry.href, label: entry.label }))}
          />
        </div>
      </div>
    </nav>
  );
}
