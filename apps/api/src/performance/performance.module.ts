import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';

/**
 * How people are doing, read from the records other modules keep. Reads the
 * database directly rather than their services, like the reports do.
 */
@Module({
  controllers: [PerformanceController],
  providers: [PerformanceService],
})
export class PerformanceModule {}
