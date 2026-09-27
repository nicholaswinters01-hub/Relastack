import { Controller, Get, Query } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import { searchQuerySchema, type SearchQuery, type SearchResponse } from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EnabledModules } from '../modules/module.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentMembershipId, CurrentPermissions } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { SearchService } from './search.service';

/**
 * Quick search. Transport only.
 *
 * No permission or module is required to call it: each kind of result checks
 * its own, and a kind the caller cannot list is left out rather than refused.
 */
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<SearchResponse> {
    return {
      results: await this.searchService.search(
        tenant,
        permissions,
        membershipId,
        enabledModules ?? new Set(),
        query.q,
      ),
    };
  }
}
