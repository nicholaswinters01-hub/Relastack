import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const STAFF_ONLY_KEY = 'staff:only';

/**
 * A staff-console route.
 *
 * StaffGuard admits only platform staff, and TenantGuard skips tenant
 * resolution — staff never act as a business. The two decisions read the same
 * flag, so there is no route that skips the tenant checks without the staff
 * check taking their place.
 */
export const StaffOnly = () => SetMetadata(STAFF_ONLY_KEY, true);

export interface StaffIdentity {
  userId: string;
  email: string;
}

export interface StaffRequest {
  staff?: StaffIdentity;
}

export const CurrentStaff = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<StaffRequest>().staff;
});
