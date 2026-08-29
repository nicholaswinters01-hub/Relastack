import { z } from 'zod';

/**
 * The module registry.
 *
 * A module is a capability the platform ships. Whether a given customer may
 * USE it is a separate question, answered by entitlement — see
 * docs/adr/0003. That separation is what lets every organization run the same
 * binary while seeing different products, and it is why enabling a module for
 * a customer is a data change rather than a deployment.
 *
 * The registry lives in code because modules ship with the build. The database
 * mirrors it for referential integrity and stores per-organization state.
 */

export const MODULES = {
  CORE: 'core',
  CRM: 'crm',
  SCHEDULING: 'scheduling',
  INVENTORY: 'inventory',
  REPORTING: 'reporting',
  AUTOMATION: 'automation',
  CUSTOM_ROLES: 'custom_roles',
} as const;

export type ModuleKey = (typeof MODULES)[keyof typeof MODULES];

export interface ModuleDefinition {
  key: ModuleKey;
  name: string;
  description: string;
  /**
   * Always on, and cannot be turned off. Disabling it would lock an
   * organization out of its own account.
   */
  isCore: boolean;
  /** Module keys that must be enabled first. */
  dependencies: ModuleKey[];
  /** Which phase delivers the functionality. Documentation, not behaviour. */
  availableFrom: string;
}

export const MODULE_REGISTRY: readonly ModuleDefinition[] = [
  {
    key: MODULES.CORE,
    name: 'Core',
    description: 'Accounts, organizations, locations, people and permissions. Always included.',
    isCore: true,
    dependencies: [],
    availableFrom: 'Phase 4',
  },
  {
    key: MODULES.CRM,
    name: 'CRM',
    description: 'Leads, customers, contacts, notes and customer history.',
    isCore: false,
    dependencies: [],
    availableFrom: 'Phase 7',
  },
  {
    key: MODULES.SCHEDULING,
    name: 'Scheduling',
    description: 'Appointments, availability and calendars.',
    isCore: false,
    // An appointment is booked FOR a customer, so scheduling without CRM has
    // nothing to attach to.
    dependencies: [MODULES.CRM],
    availableFrom: 'Phase 9',
  },
  {
    key: MODULES.INVENTORY,
    name: 'Inventory',
    description: 'Stock, items and levels per location.',
    isCore: false,
    dependencies: [],
    availableFrom: 'Phase 16',
  },
  {
    key: MODULES.REPORTING,
    name: 'Reporting',
    description: 'Dashboards and operational reports.',
    isCore: false,
    dependencies: [],
    availableFrom: 'Phase 10',
  },
  {
    key: MODULES.AUTOMATION,
    name: 'Automation',
    description: 'Trigger, condition and action workflows.',
    isCore: false,
    // Every useful trigger in the first version fires on customer data.
    dependencies: [MODULES.CRM],
    availableFrom: 'Phase 12',
  },
  {
    key: MODULES.CUSTOM_ROLES,
    name: 'Custom Roles',
    description: 'Define your own roles and permission sets, beyond the built-in ones.',
    isCore: false,
    dependencies: [],
    availableFrom: 'Phase 5',
  },
];

export const MODULE_BY_KEY: ReadonlyMap<string, ModuleDefinition> = new Map(
  MODULE_REGISTRY.map((module) => [module.key, module]),
);

/**
 * Every module a key depends on, transitively.
 *
 * Returned in dependency order, so enabling them in sequence never violates a
 * prerequisite. Throws on a cycle rather than looping — a cycle is a
 * programming error in the registry, and failing loudly at startup is far
 * better than discovering it when a customer clicks Enable.
 */
export function resolveDependencies(key: ModuleKey): ModuleKey[] {
  const resolved: ModuleKey[] = [];
  const visiting = new Set<string>();

  const visit = (current: ModuleKey, trail: string[]): void => {
    if (resolved.includes(current)) return;

    if (visiting.has(current)) {
      throw new Error(`Module dependency cycle: ${[...trail, current].join(' -> ')}`);
    }

    visiting.add(current);

    const definition = MODULE_BY_KEY.get(current);
    if (!definition) throw new Error(`Unknown module: ${current}`);

    for (const dependency of definition.dependencies) {
      visit(dependency, [...trail, current]);
    }

    visiting.delete(current);
    resolved.push(current);
  };

  visit(key, []);

  // The module itself is last; callers want only what it needs.
  return resolved.filter((entry) => entry !== key);
}

/** Modules that would break if this one were turned off. */
export function findDependents(key: ModuleKey): ModuleKey[] {
  return MODULE_REGISTRY.filter((module) => module.dependencies.includes(key)).map(
    (module) => module.key,
  );
}

// --- API contracts ---------------------------------------------------------

export const moduleStateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  isCore: z.boolean(),
  dependencies: z.array(z.string()),
  availableFrom: z.string(),
  /** Switched on by the customer. */
  enabled: z.boolean(),
  /**
   * Covered by their plan or an add-on.
   *
   * Separate from `enabled` so the interface can distinguish "turn this on"
   * from "upgrade to get this" — very different messages to show someone.
   */
  entitled: z.boolean(),
});

export type ModuleState = z.infer<typeof moduleStateSchema>;

export const modulesResponseSchema = z.object({ modules: z.array(moduleStateSchema) });
export type ModulesResponse = z.infer<typeof modulesResponseSchema>;

/** Error body when an endpoint belongs to a module the organization lacks. */
export const moduleNotEnabledSchema = z.object({
  statusCode: z.literal(403),
  code: z.literal('MODULE_NOT_ENABLED'),
  moduleKey: z.string(),
  message: z.string(),
});

export type ModuleNotEnabled = z.infer<typeof moduleNotEnabledSchema>;
