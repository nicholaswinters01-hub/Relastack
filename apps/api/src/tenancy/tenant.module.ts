import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';

/**
 * Global because TenantGuard is registered application-wide in AppModule and
 * every future business module resolves tenant context the same way.
 */
@Global()
@Module({
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
