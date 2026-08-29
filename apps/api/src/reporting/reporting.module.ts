import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reporting (Phase 10).
 *
 * Reads across CRM, tasks and scheduling but depends on none of their
 * services — it queries the tables directly through the tenant client, so a
 * module being switched off changes what the numbers contain rather than
 * breaking the report.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportingModule {}
