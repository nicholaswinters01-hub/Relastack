import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  MODULE_BY_KEY,
  MODULE_REGISTRY,
  findDependents,
  resolveDependencies,
  type ModuleKey,
  type ModuleState,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Which modules an organization may use.
 *
 * This is the ONLY question business logic asks. It never inspects plans,
 * prices or billing status — see docs/adr/0003. Phase 6 replaces the manual
 * toggles behind this interface with plan-derived entitlement, and no module
 * should need changing when it does. That is the test of whether the
 * separation actually worked.
 */
@Injectable()
export class EntitlementService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate the registry at startup.
   *
   * A dependency cycle or a reference to a module that does not exist is a
   * programming error. Discovering it when a customer clicks Enable would be
   * far worse than refusing to boot.
   */
  onModuleInit(): void {
    for (const module of MODULE_REGISTRY) {
      // Throws on a cycle or an unknown key.
      resolveDependencies(module.key);
    }

    this.logger.log(`Module registry validated: ${MODULE_REGISTRY.length} modules`);
  }

  /**
   * The set of module keys this organization may use.
   *
   * Resolved once per request by TenantGuard. A per-check database round-trip
   * would make entitlement checks expensive, and expensive checks are the ones
   * developers quietly stop adding.
   */
  async resolveFor(context: TenantContext): Promise<Set<string>> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.organizationModule.findMany({
        where: { organizationId: context.organizationId, enabled: true },
        select: { moduleKey: true },
      }),
    );

    const enabled = new Set(rows.map((row) => row.moduleKey));

    // Core is implicit. An organization whose core row went missing would
    // otherwise be locked out of its own account by a data problem.
    enabled.add(MODULES.CORE);

    return enabled;
  }

  /** Every module, with this organization's state, for the settings screen. */
  async listFor(context: TenantContext): Promise<ModuleState[]> {
    const enabled = await this.resolveFor(context);

    return MODULE_REGISTRY.map((module) => ({
      key: module.key,
      name: module.name,
      description: module.description,
      isCore: module.isCore,
      dependencies: [...module.dependencies],
      availableFrom: module.availableFrom,
      enabled: enabled.has(module.key),
    }));
  }

  /**
   * Enable a module, and anything it depends on.
   *
   * Dependencies are enabled automatically rather than refused with "enable
   * CRM first". The customer's intent is unambiguous, and making them satisfy
   * a graph by hand is busywork the software can do. Which ones were turned on
   * is returned so the interface can say so plainly.
   */
  async enable(context: TenantContext, key: string): Promise<ModuleKey[]> {
    const definition = MODULE_BY_KEY.get(key);
    if (!definition) throw new NotFoundException('Unknown module');

    const toEnable = [...resolveDependencies(definition.key), definition.key];

    await this.prisma.withTenant(context, async (tx) => {
      for (const moduleKey of toEnable) {
        await tx.organizationModule.upsert({
          where: {
            organizationId_moduleKey: { organizationId: context.organizationId, moduleKey },
          },
          create: {
            organizationId: context.organizationId,
            moduleKey,
            enabled: true,
            enabledAt: new Date(),
          },
          update: { enabled: true, enabledAt: new Date(), disabledAt: null },
        });
      }
    });

    this.logger.log(`Organization ${context.organizationId} enabled: ${toEnable.join(', ')}`);

    return toEnable;
  }

  /**
   * Disable a module.
   *
   * Non-destructive: the rows stay, only access stops. A customer who turns
   * Inventory off for a quarter and back on must find their stock intact —
   * deleting on disable would make every toggle a decision they cannot undo.
   */
  async disable(context: TenantContext, key: string): Promise<void> {
    const definition = MODULE_BY_KEY.get(key);
    if (!definition) throw new NotFoundException('Unknown module');

    if (definition.isCore) {
      // Also enforced by a database trigger, so no code path can do it.
      throw new BadRequestException('The core module cannot be disabled');
    }

    const enabled = await this.resolveFor(context);
    const blocking = findDependents(definition.key).filter((dependent) => enabled.has(dependent));

    if (blocking.length > 0) {
      // Cascading the disable would silently switch off capabilities the
      // customer did not ask to lose. Naming them lets them decide.
      const names = blocking.map((dependent) => MODULE_BY_KEY.get(dependent)?.name ?? dependent);
      throw new BadRequestException(
        `Turn off ${names.join(' and ')} first — ${definition.name} is required for ${blocking.length === 1 ? 'it' : 'them'}.`,
      );
    }

    await this.prisma.withTenant(context, (tx) =>
      tx.organizationModule.upsert({
        where: {
          organizationId_moduleKey: {
            organizationId: context.organizationId,
            moduleKey: definition.key,
          },
        },
        create: {
          organizationId: context.organizationId,
          moduleKey: definition.key,
          enabled: false,
          disabledAt: new Date(),
        },
        update: { enabled: false, disabledAt: new Date() },
      }),
    );

    this.logger.log(`Organization ${context.organizationId} disabled: ${definition.key}`);
  }

  /**
   * Enable core for a newly created organization.
   *
   * Runs inside registration's transaction, so an organization can never
   * commit without the module that carries its own account.
   */
  async enableCoreForNewOrganization(
    tx: { organizationModule: { create: (args: unknown) => Promise<unknown> } },
    organizationId: string,
  ): Promise<void> {
    await tx.organizationModule.create({
      data: {
        organizationId,
        moduleKey: MODULES.CORE,
        enabled: true,
        enabledAt: new Date(),
      },
    });
  }
}
