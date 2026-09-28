import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  integrationProviderKeySchema,
  oauthCallbackQuerySchema,
  type ConnectResponse,
  type IntegrationConnection,
  type IntegrationProviderKey,
  type IntegrationsResponse,
  type OAuthCallbackQuery,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembershipId, RequirePermission } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { IntegrationsService } from './integrations.service';

/**
 * Connected apps. Transport only.
 *
 * Owners and admins only, organization-wide: a grant to act in a business's
 * DocuSign is the whole business's, not a branch's.
 */
@Controller('integrations')
@RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<IntegrationsResponse> {
    return this.integrations.list(tenant);
  }

  @Post(':provider/connect')
  @HttpCode(HttpStatus.OK)
  async connect(
    @CurrentTenant() tenant: TenantContext,
    @Param('provider', new ZodValidationPipe(integrationProviderKeySchema))
    provider: IntegrationProviderKey,
  ): Promise<ConnectResponse> {
    return { url: await this.integrations.startConnect(tenant, provider) };
  }

  /** The provider sends the owner's browser back here; it goes on to settings. */
  @Get(':provider/callback')
  @Redirect('/settings/connected-apps', HttpStatus.FOUND)
  async callback(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Param('provider', new ZodValidationPipe(integrationProviderKeySchema))
    provider: IntegrationProviderKey,
    @Query(new ZodValidationPipe(oauthCallbackQuerySchema)) query: OAuthCallbackQuery,
  ): Promise<{ url: string }> {
    return { url: await this.integrations.completeConnect(tenant, membershipId, provider, query) };
  }

  @Post('connections/:id/check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IntegrationConnection> {
    return this.integrations.check(tenant, membershipId, id);
  }

  @Post('connections/:id/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.integrations.disconnect(tenant, membershipId, id);
  }
}
