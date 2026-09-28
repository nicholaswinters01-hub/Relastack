import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

/** Fleet: vehicles and equipment, readings, service reminders, a vehicle on a job. */
@Module({
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
