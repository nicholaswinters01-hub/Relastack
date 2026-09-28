import { Module } from '@nestjs/common';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { JobSeriesController } from './job-series.controller';
import { JobSeriesService } from './job-series.service';
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
  controllers: [JobsController, JobSeriesController, BoardController],
  providers: [JobsService, JobSeriesService, BoardService],
  exports: [JobsService, JobSeriesService],
})
export class SchedulingModule {}
