import {
  MODULES,
  PERMISSIONS,
  type PermissionKey,
  type ResolvedPermissions,
} from '@platform/shared';
import { can, canAnywhere } from '@/lib/permissions';

/**
 * Every setting in the product, in one list.
 *
 * The settings hub, quick search and each page's settings button all read
 * this, so a new setting is added once and turns up everywhere. It decides
 * only what is OFFERED: each setting's page and API enforce the same rules
 * whatever this lists.
 *
 * A plain module, not a client component, so server pages get real values.
 */

export type SettingsSectionKey =
  'you' | 'business' | 'people' | 'customers' | 'inventory' | 'fleet' | 'pest-control' | 'help';

export const SETTINGS_SECTIONS: Array<{ key: SettingsSectionKey; title: string }> = [
  { key: 'you', title: 'You' },
  { key: 'business', title: 'Business' },
  { key: 'people', title: 'People' },
  { key: 'customers', title: 'Customers' },
  { key: 'inventory', title: 'Inventory' },
  { key: 'fleet', title: 'Fleet' },
  { key: 'pest-control', title: 'Pest Control' },
  { key: 'help', title: 'Help' },
];

export interface SettingEntry {
  id: string;
  section: SettingsSectionKey;
  title: string;
  description: string;
  href: string;
  /** Extra words people might search for. */
  keywords?: string;
  /** Needed to be offered. `scope` says whether a branch grant counts. */
  permission?: PermissionKey;
  scope?: 'organization' | 'anywhere';
  /** Offered only while this module is switched on. */
  module?: string;
}

export const SETTINGS: SettingEntry[] = [
  // --- You -------------------------------------------------------------------
  {
    id: 'profile',
    section: 'you',
    title: 'Your name',
    description: 'How your name appears to everyone in the business.',
    href: '/account#profile',
    keywords: 'profile first last',
  },
  {
    id: 'notifications',
    section: 'you',
    title: 'Notifications',
    description: 'Which things reach you by email, and which only in the bell.',
    href: '/account#notifications',
    keywords: 'email alerts bell',
  },
  {
    id: 'password',
    section: 'you',
    title: 'Password',
    description: 'Change it with a reset link sent to your email.',
    href: '/forgot-password',
    keywords: 'reset security',
  },
  {
    id: 'sessions',
    section: 'you',
    title: 'Signed-in devices',
    description: 'Sign out here, or everywhere at once.',
    href: '/account#sessions',
    keywords: 'sign out logout security',
  },

  // --- Business --------------------------------------------------------------
  {
    id: 'business-name',
    section: 'business',
    title: 'Business name',
    description: 'The name shown across RelaStack and on printed records.',
    href: '/account#business',
    keywords: 'company organization rename',
    permission: PERMISSIONS.ORGANIZATION_READ,
    scope: 'organization',
  },
  {
    id: 'locations',
    section: 'business',
    title: 'Locations',
    description: 'Branches, their addresses and time zones.',
    href: '/locations',
    keywords: 'branch address timezone',
    permission: PERMISSIONS.LOCATION_READ,
    scope: 'anywhere',
  },
  {
    id: 'modules',
    section: 'business',
    title: 'Modules and packs',
    description: 'Switch parts of RelaStack on or off for the whole business.',
    href: '/modules',
    keywords: 'features industry pack enable',
    permission: PERMISSIONS.ORGANIZATION_READ,
    scope: 'organization',
  },
  {
    id: 'billing',
    section: 'business',
    title: 'Billing and plan',
    description: 'Your plan, what you pay, and payments.',
    href: '/billing',
    keywords: 'subscription invoice price payment',
    permission: PERMISSIONS.ORGANIZATION_READ,
    scope: 'organization',
  },
  {
    id: 'plans',
    section: 'business',
    title: 'Compare plans',
    description: 'What each plan includes, side by side.',
    href: '/plans',
    keywords: 'pricing tiers upgrade',
  },

  // --- People ----------------------------------------------------------------
  {
    id: 'employees',
    section: 'people',
    title: 'Employees and roles',
    description: 'Who is in the business, what they may do, and where.',
    href: '/employees',
    keywords: 'staff team invite permissions role',
    permission: PERMISSIONS.MEMBER_READ,
    scope: 'anywhere',
  },
  {
    id: 'groups',
    section: 'people',
    title: 'Groups',
    description: 'Labels like "Field crew" or "Office" to find people quickly.',
    href: '/employees#groups',
    keywords: 'team crew office',
    permission: PERMISSIONS.MEMBER_MANAGE,
    scope: 'organization',
  },

  // --- Customers -------------------------------------------------------------
  {
    id: 'customer-fields',
    section: 'customers',
    title: 'Tags and custom fields',
    description: 'Extra details you keep on every customer, and the tags to sort them.',
    href: '/customers/settings',
    keywords: 'crm fields tags',
    permission: PERMISSIONS.CUSTOMER_CONFIGURE,
    scope: 'organization',
    module: MODULES.CRM,
  },
  {
    id: 'customer-import',
    section: 'customers',
    title: 'Import customers',
    description: 'Bring in a customer list from a spreadsheet.',
    href: '/customers/import',
    keywords: 'csv spreadsheet upload',
    permission: PERMISSIONS.CUSTOMER_WRITE,
    scope: 'organization',
    module: MODULES.CRM,
  },

  // --- Inventory -------------------------------------------------------------
  {
    id: 'items',
    section: 'inventory',
    title: 'Items',
    description: 'The products and supplies you stock, their units and low-stock levels.',
    href: '/inventory',
    keywords: 'products stock sku low',
    permission: PERMISSIONS.INVENTORY_CONFIGURE,
    scope: 'organization',
    module: MODULES.INVENTORY,
  },
  {
    id: 'take-stock',
    section: 'inventory',
    title: 'Who can take stock',
    description: 'Whether employees at each branch and vehicle may record using stock themselves.',
    href: '/inventory#take-stock',
    keywords: 'employees permission branch van',
    permission: PERMISSIONS.INVENTORY_WRITE,
    scope: 'anywhere',
    module: MODULES.INVENTORY,
  },

  // --- Fleet -----------------------------------------------------------------
  {
    id: 'vehicles',
    section: 'fleet',
    title: 'Vehicles and equipment',
    description: 'Add vans and equipment, set drivers, and their service reminders.',
    href: '/fleet',
    keywords: 'van truck reminders service driver',
    permission: PERMISSIONS.FLEET_WRITE,
    scope: 'anywhere',
    module: MODULES.FLEET,
  },

  // --- Pest Control ----------------------------------------------------------
  {
    id: 'licenses',
    section: 'pest-control',
    title: 'Applicator licenses',
    description: 'License numbers and expiry dates printed on every application record.',
    href: '/employees#licenses',
    keywords: 'applicator license certification',
    permission: PERMISSIONS.MEMBER_MANAGE,
    scope: 'organization',
    module: MODULES.PEST_CONTROL,
  },
  {
    id: 'epa',
    section: 'pest-control',
    title: 'Product EPA numbers',
    description: 'Registration numbers and active ingredients, set on each item.',
    href: '/inventory',
    keywords: 'epa registration active ingredient product',
    permission: PERMISSIONS.INVENTORY_CONFIGURE,
    scope: 'organization',
    module: MODULES.PEST_CONTROL,
  },
  {
    id: 'records-export',
    section: 'pest-control',
    title: 'Records export',
    description: 'Download application records as a spreadsheet for an inspection.',
    href: '/pest-records',
    keywords: 'csv audit inspection export',
    permission: PERMISSIONS.JOB_READ,
    scope: 'anywhere',
    module: MODULES.PEST_CONTROL,
  },

  // --- Help ------------------------------------------------------------------
  {
    id: 'help',
    section: 'help',
    title: 'Ask for help',
    description: 'Send a question to the RelaStack team and see replies.',
    href: '/help',
    keywords: 'support question contact',
  },
];

/** The settings this person is offered, given their permissions and the business's modules. */
export function visibleSettings(
  permissions: ResolvedPermissions,
  enabledModules: ReadonlySet<string>,
): SettingEntry[] {
  return SETTINGS.filter((entry) => {
    if (entry.module && !enabledModules.has(entry.module)) return false;
    if (!entry.permission) return true;
    return entry.scope === 'anywhere'
      ? canAnywhere(permissions, entry.permission)
      : can(permissions, entry.permission);
  });
}
