import { Module } from '@nestjs/common';
import { PestControlController } from './pest-control.controller';
import { PestRecordsService } from './pest-records.service';

/** The Pest Control pack: application records built on the core's job materials. */
@Module({
  controllers: [PestControlController],
  providers: [PestRecordsService],
})
export class PestControlModule {}
