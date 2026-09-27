import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffGuard } from './staff.guard';
import { StaffService } from './staff.service';

@Module({
  controllers: [StaffController],
  providers: [StaffService, StaffGuard],
  exports: [StaffGuard],
})
export class StaffModule {}
