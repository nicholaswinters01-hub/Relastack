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
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
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
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryResponse> {
    return this.inventory.overview(tenant, permissions, query.includeArchived === 'true');
  }

  @Get('items/:id')
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_READ)
  item(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ItemDetailResponse> {
    return this.inventory.item(tenant, permissions, id);
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PERMISSIONS.INVENTORY_CONFIGURE)
  createItem(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(createItemRequestSchema)) body: CreateItemRequest,
  ): Promise<InventoryItem> {
    return this.inventory.createItem(tenant, body);
  }

  @Patch('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.INVENTORY_CONFIGURE)
  updateItem(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateItemRequestSchema)) body: UpdateItemRequest,
  ): Promise<void> {
    return this.inventory.updateItem(tenant, id, body);
  }

  @Patch('places/:id')
  @RequirePermissionAnywhere(PERMISSIONS.INVENTORY_WRITE)
  updatePlace(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePlaceRequestSchema)) body: UpdatePlaceRequest,
  ): Promise<StockPlace> {
    return this.inventory.updatePlace(tenant, permissions, id, body);
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
}
