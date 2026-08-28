import { Global, Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * Global because TenantGuard resolves permissions for every request, and every
 * business module from Phase 7 on asks the same authorization question.
 */
@Global()
@Module({
  controllers: [RolesController],
  providers: [PermissionService, RolesService],
  exports: [PermissionService, RolesService],
})
export class RbacModule {}
