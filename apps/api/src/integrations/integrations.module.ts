import { Module } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { SERVER_ENV } from '../config.provider';
import { DocuSignAdapter } from './docusign.adapter';
import { IntegrationsController } from './integrations.controller';
import { INTEGRATION_ADAPTERS, IntegrationsService } from './integrations.service';
import { TokenVault } from './token-vault';

/**
 * Connected apps (Phase 11a): the connection layer, and its adapters.
 * Exported for the modules that act through it, such as Contracts.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [
    DocuSignAdapter,
    {
      provide: TokenVault,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv) => new TokenVault(env.INTEGRATION_TOKEN_KEYS),
    },
    {
      provide: INTEGRATION_ADAPTERS,
      inject: [DocuSignAdapter],
      useFactory: (docusign: DocuSignAdapter) => [docusign],
    },
    IntegrationsService,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
