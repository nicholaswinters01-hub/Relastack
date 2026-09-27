import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/** The help desk, business side. The staff inbox lives in StaffModule. */
@Module({
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
