import { BadRequestException } from '@nestjs/common';
import { PACK_FIELDS, type PackFieldTarget } from '@platform/shared';
import type { ZodError } from 'zod';

type Fields = Record<string, unknown>;

const asObject = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};

function refuse(packKey: string, error: ZodError): never {
  throw new BadRequestException({
    statusCode: 400,
    message: error.issues[0]?.message ?? 'Validation failed',
    errors: error.issues.map((issue) => ({
      field: ['packFields', packKey, ...issue.path].join('.'),
      message: issue.message,
    })),
  });
}

/**
 * Check what packs add to a core record, and return what to store.
 *
 * The core's side of the connection point. It never reads inside a pack's
 * fields; it asks the catalogue which enabled packs add fields to this kind of
 * record and lets each pack's schema decide.
 *
 *   - A key for a pack the business does not have is refused, never stored.
 *   - `merge` (items, people): a pack's incoming fields are merged over what
 *     the record already has INSIDE the caller's transaction, and the merged
 *     result is validated, so sending one field never wipes the others.
 *   - `require` (a treatment line): every enabled pack with fields for this
 *     record must be given them.
 *   - Fields belonging to a pack that has since been switched off stay as
 *     they were: hidden, never deleted.
 */
export function checkPackFields(
  target: PackFieldTarget,
  incoming: Fields | undefined,
  existing: unknown,
  enabledModules: ReadonlySet<string>,
  mode: 'merge' | 'require',
): Fields {
  const result: Fields = { ...asObject(existing) };
  const given = incoming ?? {};

  for (const packKey of Object.keys(given)) {
    if (!PACK_FIELDS[packKey]?.[target] || !enabledModules.has(packKey)) {
      throw new BadRequestException(`Fields for "${packKey}" are not available here`);
    }
  }

  for (const [packKey, targets] of Object.entries(PACK_FIELDS)) {
    const schema = targets[target];
    if (!schema || !enabledModules.has(packKey)) continue;
    if (mode === 'merge' && !(packKey in given)) continue;

    const candidate =
      mode === 'merge'
        ? { ...asObject(result[packKey]), ...asObject(given[packKey]) }
        : given[packKey];
    const parsed = schema.safeParse(candidate ?? {});
    if (!parsed.success) refuse(packKey, parsed.error);
    result[packKey] = parsed.data;
  }

  return result;
}
