import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { InvitationsModule } from './invitations/invitations.module';
import { CrmModule } from './crm/crm.module';
import { TasksModule } from './tasks/tasks.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { ReportingModule } from './reporting/reporting.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LocationsModule } from './locations/locations.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { TenantModule } from './tenancy/tenant.module';
import { TenantGuard } from './tenancy/tenant.guard';
import { BillingModule } from './billing/billing.module';
import { ReadOnlyGuard } from './billing/read-only.guard';
import { ModulesModule } from './modules/modules.module';
import { EntitlementGuard } from './modules/entitlement.guard';
import { RbacModule } from './rbac/rbac.module';
import { PermissionGuard } from './rbac/permission.guard';
import { AppThrottlerGuard } from './common/app-throttler.guard';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { SERVER_ENV, type ServerEnv } from './config.provider';
import { StaffGuard } from './staff/staff.guard';
import { StaffModule } from './staff/staff.module';
import { SupportModule } from './support/support.module';
import { SearchModule } from './search/search.module';
import { GroupsModule } from './groups/groups.module';

/**
 * Application root.
 *
 * PrismaModule and configuration are platform infrastructure — always loaded.
 * Feature modules are registered here as they arrive:
 *
 *   Phase 2 — OrganizationsModule
 *   Phase 4 — RbacModule
 *
 * Note that "registered here" is not the same as "enabled for a customer".
 * From Phase 5 onward a module being loaded into the process is independent of
 * whether a given organization is entitled to use it — that is enforced per
 * request by the entitlement guard, not by what is compiled into the build.
 */
@Module({
  imports: [
    PrismaModule,

    // One baseline throttler covering every route. Endpoints needing a
    // tighter limit override it with @Throttle — see AuthController.
    //
    // Deliberately NOT several named throttlers: with multiple names, every
    // throttler applies to every route unless individually skipped, so the
    // strict login limit would silently also govern ordinary reads.
    ThrottlerModule.forRootAsync({
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE }],
      }),
    }),

    TenantModule,
    RbacModule,
    BillingModule,
    NotificationsModule,
    ModulesModule,
    AuthModule,
    OrganizationsModule,
    LocationsModule,
    InvitationsModule,
    CrmModule,
    TasksModule,
    SchedulingModule,
    ReportingModule,
    HealthModule,
    StaffModule,
    SupportModule,
    SearchModule,
    GroupsModule,
  ],
  providers: [
    // ORDER MATTERS. Guards run in registration order, so rate limiting is
    // evaluated before authentication. Otherwise an attacker could force
    // unlimited Argon2 verifications — expensive by design — simply by sending
    // wrong passwords, turning our own password hardening into a DoS vector.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },

    // Authentication is global: every endpoint is protected unless it carries
    // @Public(). Protection is the default; exposure is the explicit choice.
    { provide: APP_GUARD, useClass: AuthGuard },

    // Staff routes only, and before TenantGuard: those routes skip tenant
    // resolution, so the staff check must already have run.
    { provide: APP_GUARD, useClass: StaffGuard },

    // Tenant context, also global and also fail-closed. Runs after AuthGuard,
    // so the caller is already known. An endpoint that forgets to declare its
    // intent gets no tenant context, and RLS policies then return nothing —
    // an obviously broken endpoint rather than a quiet cross-tenant leak.
    { provide: APP_GUARD, useClass: TenantGuard },

    // Last: permissions are resolved by TenantGuard above, so this only reads
    // what is already on the request. Endpoints without @RequirePermission
    // pass through — see the note in PermissionGuard for why that is not a
    // fail-open hole.
    { provide: APP_GUARD, useClass: PermissionGuard },

    // Last: module entitlement. Reads what TenantGuard resolved. This is what
    // makes a disabled module unreachable rather than merely hidden —
    // endpoints without @RequireModule belong to core, which is always on.
    { provide: APP_GUARD, useClass: EntitlementGuard },

    // Last of all. A lapsed subscription narrows the account to read-only, and
    // running this after the others means the more specific failures — not
    // signed in, wrong organization, module not enabled — are reported first.
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
  ],
})
export class AppModule {}
