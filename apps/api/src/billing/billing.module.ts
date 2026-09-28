import { Global, Module } from '@nestjs/common';
import { BillingController, PublicPlansController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Global because TenantGuard resolves a subscription for every request, and
 * both entitlement and location limits depend on it.
 */
@Global()
@Module({
  controllers: [BillingController, PublicPlansController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
