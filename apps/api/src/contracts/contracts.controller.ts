import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  contractsQuerySchema,
  integrationProviderKeySchema,
  sendContractRequestSchema,
  voidContractRequestSchema,
  type ContractResponse,
  type ContractTemplatesResponse,
  type ContractsQuery,
  type ContractsResponse,
  type IntegrationProviderKey,
  type SendContractRequest,
  type TemplateDetail,
  type VoidContractRequest,
} from '@platform/shared';
import { z } from 'zod';
import { Public } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { ContractsService } from './contracts.service';

/**
 * Contracts. Transport only. Reading follows customer visibility; sending,
 * checking and withdrawing are authorised per customer by the service.
 */
@Controller('contracts')
@RequireModule(MODULES.CONTRACTS)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Query(new ZodValidationPipe(contractsQuerySchema)) query: ContractsQuery,
  ): Promise<ContractsResponse> {
    return { contracts: await this.contracts.list(tenant, permissions, query) };
  }

  @Get('templates')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  templates(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
  ): Promise<ContractTemplatesResponse> {
    return this.contracts.templates(tenant, membershipId);
  }

  @Get('templates/:provider/:templateId')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  template(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Param('provider', new ZodValidationPipe(integrationProviderKeySchema))
    provider: IntegrationProviderKey,
    @Param('templateId', new ZodValidationPipe(z.string().min(1).max(100))) templateId: string,
  ): Promise<TemplateDetail> {
    return this.contracts.template(tenant, membershipId, provider, templateId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async send(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(sendContractRequestSchema)) body: SendContractRequest,
  ): Promise<ContractResponse> {
    return { contract: await this.contracts.send(tenant, permissions, membershipId, body) };
  }

  @Get(':id')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContractResponse> {
    return { contract: await this.contracts.get(tenant, permissions, id) };
  }

  @Post(':id/check')
  @HttpCode(HttpStatus.OK)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async check(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContractResponse> {
    return { contract: await this.contracts.check(tenant, permissions, membershipId, id) };
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async voidContract(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(voidContractRequestSchema)) body: VoidContractRequest,
  ): Promise<ContractResponse> {
    return {
      contract: await this.contracts.voidContract(
        tenant,
        permissions,
        membershipId,
        id,
        body.reason,
      ),
    };
  }

  /** The signed copy, straight from the provider. */
  @Get(':id/document')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  @Header('content-type', 'application/pdf')
  @Header('cache-control', 'private, no-store')
  async document(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.contracts.document(tenant, permissions, membershipId, id);
    return new StreamableFile(pdf, { disposition: `inline; filename="${filename}"` });
  }
}

/**
 * Where a provider reports progress on documents sent. Public: the provider
 * has no session. The business is in the path and a secret proves the
 * address was one we handed out; anything else is not found.
 */
@Public()
@Controller('webhooks')
export class ContractWebhooksController {
  constructor(private readonly contracts: ContractsService) {}

  @Post(':provider/:organizationId/:token')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider', new ZodValidationPipe(integrationProviderKeySchema))
    provider: IntegrationProviderKey,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('token', new ZodValidationPipe(z.string().regex(/^[A-Za-z0-9_-]{20,100}$/)))
    token: string,
    @Body() payload: unknown,
  ): Promise<{ ok: true }> {
    const known = await this.contracts.webhook(organizationId, provider, token, payload);
    if (!known) throw new NotFoundException();
    return { ok: true };
  }
}
