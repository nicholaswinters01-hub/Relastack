import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Application root.
 *
 * PrismaModule and configuration are platform infrastructure — always loaded.
 * Feature modules are registered here as they arrive:
 *
 *   Phase 1 — AuthModule
 *   Phase 2 — OrganizationsModule
 *   Phase 3 — LocationsModule
 *   Phase 4 — RbacModule
 *   Phase 5 — ModuleRegistryModule
 *
 * Note that "registered here" is not the same as "enabled for a customer".
 * From Phase 5 onward a module being loaded into the process is independent of
 * whether a given organization is entitled to use it — that is enforced per
 * request by the entitlement guard, not by what is compiled into the build.
 */
@Module({
  imports: [PrismaModule, HealthModule],
})
export class AppModule {}
