import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

/**
 * Exported because Phase 6 needs the active-location count to price a
 * subscription, and the locations module owns what counts as billable.
 */
@Module({
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
