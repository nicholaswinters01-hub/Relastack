import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import {
  buildCustomFieldSchema,
  type CreateCustomFieldRequest,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type UpdateCustomFieldRequest,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

type DefinitionRow = Prisma.CustomFieldDefinitionGetPayload<Record<string, never>>;

/**
 * Fields an organization defines for itself.
 *
 * This is what "prefer configuration over customer-specific branches" means in
 * practice. A landscaping company needing a "Gate code" and a plumber needing
 * a "Boiler model" are the same feature, and neither is a fork of the product.
 *
 * Definitions are rows; the values live in a JSONB column on the customer.
 */
@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  static toPublic(row: DefinitionRow): CustomFieldDefinition {
    return {
      id: row.id,
      key: row.key,
      label: row.label,
      type: row.type,
      options: (row.options ?? []) as string[],
      isRequired: row.isRequired,
      position: row.position,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  async list(context: TenantContext, includeArchived = false): Promise<CustomFieldDefinition[]> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.customFieldDefinition.findMany({
        where: { entity: 'CUSTOMER', ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );

    return rows.map(CustomFieldsService.toPublic);
  }

  /**
   * Validates values against this organization's definitions.
   *
   * The schema is built per request rather than cached: definitions change
   * rarely but a stale cache would silently reject a field the customer just
   * created, which is the worst possible moment to be wrong.
   */
  async validate(context: TenantContext, values: CustomFieldValues): Promise<CustomFieldValues> {
    return this.validateWith(await this.list(context), values);
  }

  /**
   * The same check against definitions already loaded.
   *
   * Separate so a caller inside a transaction can merge existing values with
   * incoming ones and validate the result, without opening a second
   * withTenant inside the first.
   */
  validateWith(definitions: CustomFieldDefinition[], values: CustomFieldValues): CustomFieldValues {
    if (definitions.length === 0) return {};

    const result = buildCustomFieldSchema(definitions).safeParse(values);

    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Some custom fields are not valid',
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }

  async create(
    context: TenantContext,
    input: CreateCustomFieldRequest,
  ): Promise<CustomFieldDefinition> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const clash = await tx.customFieldDefinition.findFirst({
        where: { entity: 'CUSTOMER', key: input.key },
      });

      if (clash) {
        throw new ConflictException(`A field with the key "${input.key}" already exists`);
      }

      return tx.customFieldDefinition.create({
        data: {
          organizationId: context.organizationId,
          entity: 'CUSTOMER',
          key: input.key,
          label: input.label,
          type: input.type,
          options: input.options,
          isRequired: input.isRequired,
          position: input.position,
        },
      });
    });

    return CustomFieldsService.toPublic(row);
  }

  /**
   * The key and the type are immutable.
   *
   * Changing either would orphan every value already stored, which is the one
   * thing this design exists to avoid. Retire the field and add a new one.
   */
  async update(
    context: TenantContext,
    id: string,
    input: UpdateCustomFieldRequest,
  ): Promise<CustomFieldDefinition> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const existing = await tx.customFieldDefinition.findFirst({ where: { id } });

      if (!existing) throw new NotFoundException('Field not found');

      if (input.options !== undefined && existing.type !== 'SELECT') {
        throw new BadRequestException('Only a choice field has options');
      }

      if (existing.type === 'SELECT' && input.options?.length === 0) {
        throw new BadRequestException('A choice field needs at least one option');
      }

      return tx.customFieldDefinition.update({
        where: { id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
          ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });
    });

    return CustomFieldsService.toPublic(row);
  }

  /**
   * Retire a field without touching the values.
   *
   * The field stops appearing on forms and stops accepting new values, but
   * everything already recorded stays in place — so restoring the field brings
   * the history back rather than a column of blanks. Deleting the values would
   * be a destructive answer to a presentational question.
   */
  async archive(context: TenantContext, id: string): Promise<CustomFieldDefinition> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const updated = await tx.customFieldDefinition.updateMany({
        where: { id, archivedAt: null },
        data: { archivedAt: new Date() },
      });

      if (updated.count === 0) throw new NotFoundException('Field not found');

      return tx.customFieldDefinition.findUniqueOrThrow({ where: { id } });
    });

    return CustomFieldsService.toPublic(row);
  }

  async restore(context: TenantContext, id: string): Promise<CustomFieldDefinition> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const updated = await tx.customFieldDefinition.updateMany({
        where: { id, archivedAt: { not: null } },
        data: { archivedAt: null },
      });

      if (updated.count === 0) throw new NotFoundException('Field not found');

      return tx.customFieldDefinition.findUniqueOrThrow({ where: { id } });
    });

    return CustomFieldsService.toPublic(row);
  }
}
