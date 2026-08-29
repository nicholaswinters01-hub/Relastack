import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import type { CreateTagRequest, Tag, UpdateTagRequest } from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

const TAG_INCLUDE = { _count: { select: { customers: true } } } as const;

type TagRow = Prisma.TagGetPayload<{ include: typeof TAG_INCLUDE }>;

/**
 * The organization's tag vocabulary.
 *
 * A table rather than free text on each customer, so correcting a misspelled
 * tag is one update instead of a scan, and so the interface can offer the
 * existing vocabulary rather than inviting five spellings of "commercial".
 */
@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  static toPublic(row: TagRow): Tag {
    return {
      id: row.id,
      name: row.name,
      color: row.color as Tag['color'],
      customerCount: row._count.customers,
    };
  }

  async list(context: TenantContext): Promise<Tag[]> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.tag.findMany({ include: TAG_INCLUDE, orderBy: { name: 'asc' } }),
    );

    return rows.map(TagsService.toPublic);
  }

  async create(context: TenantContext, input: CreateTagRequest): Promise<Tag> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const clash = await tx.tag.findFirst({ where: { name: input.name } });

      if (clash) throw new ConflictException(`A tag called "${input.name}" already exists`);

      return tx.tag.create({
        data: {
          organizationId: context.organizationId,
          name: input.name,
          color: input.color,
        },
        include: TAG_INCLUDE,
      });
    });

    return TagsService.toPublic(row);
  }

  async update(context: TenantContext, id: string, input: UpdateTagRequest): Promise<Tag> {
    const row = await this.prisma.withTenant(context, async (tx) => {
      const existing = await tx.tag.findFirst({ where: { id } });

      if (!existing) throw new NotFoundException('Tag not found');

      if (input.name !== undefined && input.name !== existing.name) {
        const clash = await tx.tag.findFirst({ where: { name: input.name } });

        if (clash) throw new ConflictException(`A tag called "${input.name}" already exists`);
      }

      return tx.tag.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
        },
        include: TAG_INCLUDE,
      });
    });

    return TagsService.toPublic(row);
  }

  /**
   * Deleting a tag removes it from every customer.
   *
   * The cascade is the point: a tag that exists on no customer but still
   * appears in the vocabulary is clutter. The interface warns with the count
   * first, which is why customerCount is on the read model.
   */
  async remove(context: TenantContext, id: string): Promise<void> {
    const deleted = await this.prisma.withTenant(context, (tx) =>
      tx.tag.deleteMany({ where: { id } }),
    );

    if (deleted.count === 0) throw new NotFoundException('Tag not found');
  }
}
