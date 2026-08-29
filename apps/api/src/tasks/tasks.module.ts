import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Tasks (Phase 8).
 *
 * Core rather than a business module, and deliberately depends on no other
 * module. Phase 9 scheduling and Phase 12 automation both build on this.
 */
@Module({
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
