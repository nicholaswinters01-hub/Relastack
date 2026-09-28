import { BadRequestException } from '@nestjs/common';
import type { TransactionClient } from '@platform/db';
import {
  MODULES,
  pestItemFieldsSchema,
  pestMemberFieldsSchema,
  type PestTreatmentFields,
  type PestTreatmentRecord,
} from '@platform/shared';

const nameOf = (user: { firstName: string | null; lastName: string | null; email: string }) =>
  [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

/**
 * Turn what a tech entered into the application record that is kept.
 *
 * The product's registration number and the applicator's license are copied
 * in as they are today. A record is evidence of what happened on the day, so
 * it must not change when somebody later edits the item or renews a license.
 */
export async function enrichPestTreatment(
  tx: TransactionClient,
  entered: PestTreatmentFields,
  item: { name: string; packFields: unknown },
  recorderMembershipId: string,
): Promise<PestTreatmentRecord> {
  const applicatorId = entered.applicatorMembershipId ?? recorderMembershipId;
  const applicator = await tx.organizationMembership.findUnique({
    where: { id: applicatorId },
    select: {
      packFields: true,
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!applicator) throw new BadRequestException('That applicator is not in this business');

  const license = pestMemberFieldsSchema
    .catch({})
    .parse((applicator.packFields as Record<string, unknown>)[MODULES.PEST_CONTROL] ?? {});
  const product = pestItemFieldsSchema
    .catch({})
    .parse((item.packFields as Record<string, unknown>)[MODULES.PEST_CONTROL] ?? {});

  return {
    ...entered,
    applicatorMembershipId: applicatorId,
    applicatorName: nameOf(applicator.user),
    applicatorLicense: license.licenseNumber ?? null,
    applicatorLicenseExpiresOn: license.licenseExpiresOn ?? null,
    productName: item.name,
    epaRegistrationNumber: product.epaRegistrationNumber ?? null,
    activeIngredient: product.activeIngredient ?? null,
  };
}
