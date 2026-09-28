import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createItemRequestSchema,
  inventoryQuerySchema,
  stockChangeRequestSchema,
  updateItemRequestSchema,
  updatePlaceRequestSchema,
  type CreateItemRequest,
  type InventoryItem,
  type InventoryQuery,
  type InventoryResponse,
  type ItemDetailResponse,
  type StockChangeRequest,
  type StockChangeResponse,
  type StockPlace,
  type UpdateItemRequest,
  type UpdatePlaceRequest,
  recordJobMaterialRequestSchema,
  voidJobMaterialRequestSchema,
  type JobMaterialsResponse,
  type RecordJobMaterialRequest,
  type VoidJobMaterialRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EnabledModules, RequireModule } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermission,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { InventoryService } from './inventory.service';

/**
 * Inventory. Transport only.
 *
 * Reads need inventory.read somewhere and are narrowed to the caller's
 * branches by the service. Stock changes are authorised per place by the
 * service, because the branch is in the body and whether employees may take
 * stock is that branch's own setting.
 */
@Controller('inventory')
@RequireModule(MODULES.INVENTORY)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  overview(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryResponse> {
    return this.inventory.overview(
      tenant,
      permissions,
      membershipId,
      query.includeArchived === 'true',
    );
  }

  @Get('items/:id')
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  item(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ItemDetailResponse> {
    return this.inventory.item(tenant, permissions, membershipId, id);
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PERMISSIONS.INVENTORY_CONFIGURE)
  createItem(
    @CurrentTenant() tenant: TenantContext,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Body(new ZodValidationPipe(createItemRequestSchema)) body: CreateItemRequest,
  ): Promise<InventoryItem> {
    return this.inventory.createItem(tenant, enabledModules ?? new Set(), body);
  }

  @Patch('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.INVENTORY_CONFIGURE)
  updateItem(
    @CurrentTenant() tenant: TenantContext,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateItemRequestSchema)) body: UpdateItemRequest,
  ): Promise<void> {
    return this.inventory.updateItem(tenant, enabledModules ?? new Set(), id, body);
  }

  @Patch('places/:id')
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_WRITE)
  updatePlace(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(updatePlaceRequestSchema)) body: UpdatePlaceRequest,
  ): Promise<StockPlace> {
    return this.inventory.updatePlace(tenant, permissions, membershipId, id, body);
  }

  /** Receive, use, count, move, damaged or correct. See the service for 409s. */
  @Post('changes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  change(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(stockChangeRequestSchema)) body: StockChangeRequest,
  ): Promise<StockChangeResponse> {
    return this.inventory.change(tenant, permissions, membershipId, body);
  }

  // --- Materials used on a job ----------------------------------------------

  /** The crew or anyone who can see the job. Authority is checked by the service. */
  @Get('jobs/:jobId/materials')
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  jobMaterials(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<JobMaterialsResponse> {
    return this.inventory.jobMaterials(tenant, permissions, membershipId, jobId);
  }

  @Post('jobs/:jobId/materials')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  recordJobMaterial(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body(new ZodValidationPipe(recordJobMaterialRequestSchema)) body: RecordJobMaterialRequest,
  ): Promise<JobMaterialsResponse> {
    return this.inventory.recordJobMaterial(
      tenant,
      permissions,
      membershipId,
      enabledModules ?? new Set(),
      jobId,
      body,
    );
  }

  @Post('materials/:id/void')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  voidJobMaterial(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(voidJobMaterialRequestSchema)) body: VoidJobMaterialRequest,
  ): Promise<void> {
    return this.inventory.voidJobMaterial(tenant, permissions, membershipId, id, body.reason);
  }
}
