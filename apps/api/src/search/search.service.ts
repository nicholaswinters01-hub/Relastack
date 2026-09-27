import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  customerQuerySchema,
  jobQuerySchema,
  MODULES,
  PERMISSIONS,
  SEARCH_RESULTS_PER_KIND,
  taskQuerySchema,
  type SearchResult,
} from '@platform/shared';
import { CustomersService } from '../crm/customers.service';
import { LocationsService } from '../locations/locations.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { PermissionSet } from '../rbac/permission-set';
import { JobsService } from '../scheduling/jobs.service';
import { TasksService } from '../tasks/tasks.service';

const LIMIT = SEARCH_RESULTS_PER_KIND;

/**
 * Quick search across everything a person can open.
 *
 * No queries of its own: each kind asks the service behind its list page,
 * with that page's permission check, visibility filter and module switch. A
 * kind the person could not list is simply skipped, so searching never
 * answers "access denied" and never reveals more than the lists would.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly customers: CustomersService,
    private readonly jobs: JobsService,
    private readonly tasks: TasksService,
    private readonly locations: LocationsService,
    private readonly organizations: OrganizationsService,
  ) {}

  async search(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    enabledModules: Set<string>,
    q: string,
  ): Promise<SearchResult[]> {
    const term = q.toLowerCase();
    const matches = (...values: Array<string | null | undefined>) =>
      values.some((value) => value?.toLowerCase().includes(term));

    const [customers, jobs, tasks, members, locations] = await Promise.all([
      enabledModules.has(MODULES.CRM) && permissions.hasAnywhere(PERMISSIONS.CUSTOMER_READ)
        ? this.customers
            .list(
              context,
              permissions,
              // Archived too: finding a former customer again is the point.
              customerQuerySchema.parse({ search: q, limit: LIMIT, includeArchived: true }),
            )
            .then((page) =>
              page.customers.map((customer): SearchResult => ({
                kind: 'customer',
                id: customer.id,
                title: customer.displayName,
                subtitle:
                  [
                    customer.stage === 'ARCHIVED' ? 'Archived' : null,
                    customer.email,
                    customer.phone,
                  ]
                    .filter(Boolean)
                    .join(' · ') || null,
                at: null,
                href: `/customers/${customer.id}`,
              })),
            )
        : [],

      enabledModules.has(MODULES.SCHEDULING) && permissions.hasAnywhere(PERMISSIONS.JOB_READ)
        ? this.jobs
            .list(
              context,
              permissions,
              membershipId,
              jobQuerySchema.parse({ search: q, limit: LIMIT }),
            )
            .then((page) =>
              page.jobs.map((job): SearchResult => ({
                kind: 'job',
                id: job.id,
                title: job.title,
                // Already null when the reader may not see the customer.
                subtitle: job.customerName,
                at: job.startsAt,
                href: `/jobs/${job.id}`,
              })),
            )
        : [],

      permissions.hasAnywhere(PERMISSIONS.TASK_READ)
        ? this.tasks
            .list(
              context,
              permissions,
              membershipId,
              taskQuerySchema.parse({ search: q, limit: LIMIT }),
            )
            .then((page) =>
              page.tasks.map((task): SearchResult => ({
                kind: 'task',
                id: task.id,
                title: task.title,
                subtitle: task.customerName,
                at: null,
                href: `/tasks/${task.id}`,
              })),
            )
        : [],

      // Organization-wide, like the team page itself.
      permissions.has(PERMISSIONS.MEMBER_READ)
        ? this.organizations.listMembers(context).then((all) =>
            all
              .filter((member) => matches(member.email, member.firstName, member.lastName))
              .slice(0, LIMIT)
              .map((member): SearchResult => ({
                kind: 'member',
                id: member.membershipId,
                title:
                  [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
                subtitle: member.email,
                at: null,
                href: '/team',
              })),
          )
        : [],

      permissions.hasAnywhere(PERMISSIONS.LOCATION_READ)
        ? this.locations.list(context, permissions).then((all) =>
            all
              .filter((location) => matches(location.name, location.city))
              .slice(0, LIMIT)
              .map((location): SearchResult => ({
                kind: 'location',
                id: location.id,
                title: location.name,
                subtitle: [location.city, location.region].filter(Boolean).join(', ') || null,
                at: null,
                href: '/locations',
              })),
          )
        : [],
    ]);

    return [...customers, ...jobs, ...tasks, ...members, ...locations];
  }
}
