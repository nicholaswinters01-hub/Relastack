import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ContractsController, ContractWebhooksController } from './contracts.controller';
import { ContractsService } from './contracts.service';

/** Contracts: documents sent for signature through a connected account. */
@Module({
  imports: [IntegrationsModule],
  controllers: [ContractsController, ContractWebhooksController],
  providers: [ContractsService],
})
export class ContractsModule {}
