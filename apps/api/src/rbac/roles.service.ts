import { ConflictException, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import { ALL_PERMISSIONS, type CreateCustomRoleRequest, type Role } from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Roles this organization can assign.
   *
   * RLS admits shared system roles (null organization_id) alongside the
   * tenant's own, so no filter is needed — the policy already expresses it.
   */
  async list(context: TenantContext): Promise<Role[]> {
    const roles = await this.prisma.withTenant(context, (tx) =>
      tx.role.findMany({
        include: { permissions: true },
        orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      }),
    );

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      defaultScope: role.defaultScope,
      isSystem: role.isSystem,
      permissions: role.permissions.map((entry) => entry.permissionKey),
    }));
  }

  /**
   * Create an organization-defined role.
   *
   * Reachable only when the Custom Roles module is enabled — enforced by the
   * guard on the controller, not here, so this service stays unaware of
   * commercial packaging.
   */
  async createCustom(context: TenantContext, input: CreateCustomRoleRequest): Promise<void> {
    const unknown = input.permissions.filter(
      (permission) => !ALL_PERMISSIONS.includes(permission as never),
    );

    if (unknown.length > 0) {
      // Silently dropping them would create a role that looks more capable
      // than it is.
      throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);
    }

    try {
      await this.prisma.withTenant(context, async (tx) => {
        const role = await tx.role.create({
          data: {
            organizationId: context.organizationId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            defaultScope: input.defaultScope,
            // Customer-defined roles are never system roles, so they remain
            // editable and deletable by the organization that made them.
            isSystem: false,
          },
        });

        await tx.rolePermission.createMany({
          data: input.permissions.map((permissionKey) => ({
            roleId: role.id,
            permissionKey,
          })),
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A role with that key already exists');
      }
      throw error;
    }

    this.logger.log(`Custom role ${input.key} created in ${context.organizationId}`);
  }
}
