import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * Scheduling (Phase 9).
 *
 * A business module, gated by entitlement, depending on no other module in
 * code — it reads customers and locations through the database, not through
 * the CRM module's services.
 */
@Module({
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class SchedulingModule {}
