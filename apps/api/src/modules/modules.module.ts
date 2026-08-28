import { Global, Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { ModulesController } from './modules.controller';

/**
 * Global because TenantGuard resolves entitlements for every request, and
 * registration needs to enable core inside its own transaction.
 */
@Global()
@Module({
  controllers: [ModulesController],
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class ModulesModule {}
