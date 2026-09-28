import {
  BadRequestException,
  ForbiddenException,
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
import { BillingService, type ResolvedSubscription } from '../billing/billing.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

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
  async resolveFor(
    context: TenantContext,
    subscription?: ResolvedSubscription | null,
  ): Promise<Set<string>> {
    const [rows, resolved] = await Promise.all([
      this.prisma.withTenant(context, (tx) =>
        tx.organizationModule.findMany({
          where: { organizationId: context.organizationId, enabled: true },
          select: { moduleKey: true },
        }),
      ),
      // Passed in by TenantGuard, which already has it. Falling back to a
      // lookup keeps the service usable from jobs and tests.
      subscription !== undefined ? Promise.resolve(subscription) : this.billing.resolveFor(context),
    ]);

    const switchedOn = new Set(rows.map((row) => row.moduleKey));

    // A module is available only if it is BOTH switched on by the customer and
    // covered by what they pay for. Two separate questions:
    //
    //   entitled  — commercial. Their plan or an add-on includes it.
    //   enabled   — operational. They chose to turn it on.
    //
    // Keeping them apart means a downgrade stops access without silently
    // erasing the customer's choices, so an upgrade restores exactly what they
    // had rather than a blank slate.
    const entitled = resolved?.entitledModules;
    const available = entitled
      ? new Set([...switchedOn].filter((key) => entitled.has(key)))
      : switchedOn;

    // Core is implicit regardless. An organization whose core row went missing,
    // or whose plan omits it, must never be locked out of its own account.
    available.add(MODULES.CORE);

    return available;
  }

  /** Every module, with this organization's state, for the settings screen. */
  async listFor(context: TenantContext): Promise<ModuleState[]> {
    const subscription = await this.billing.resolveFor(context);
    const enabled = await this.resolveFor(context, subscription);

    return MODULE_REGISTRY.map((module) => ({
      key: module.key,
      name: module.name,
      description: module.description,
      isCore: module.isCore,
      dependencies: [...module.dependencies],
      availableFrom: module.availableFrom,
      kind: module.kind,
      includes: [...module.includes],
      enabled: enabled.has(module.key),
      // Whether the plan covers it. The interface uses this to distinguish
      // "turn on" from "upgrade to get this", which are very different
      // messages to show a customer.
      entitled: module.isCore || (subscription?.entitledModules.has(module.key) ?? false),
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

    // Checked before writing anything, so a partially-applied enable cannot
    // leave dependencies switched on for a module the customer never got.
    const subscription = await this.billing.resolveFor(context);

    if (subscription) {
      const missing = toEnable.filter(
        (moduleKey) => moduleKey !== MODULES.CORE && !subscription.entitledModules.has(moduleKey),
      );

      if (missing.length > 0) {
        const names = missing.map((moduleKey) => MODULE_BY_KEY.get(moduleKey)?.name ?? moduleKey);

        // 403 with a machine-readable code rather than 404: the module plainly
        // exists — it is on the pricing page — and the interface needs to be
        // able to offer the upgrade rather than pretend nothing is there.
        throw new ForbiddenException({
          statusCode: 403,
          code: 'REQUIRES_UPGRADE',
          moduleKeys: missing,
          message: `${names.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not included in your plan.`,
        });
      }
    }

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
