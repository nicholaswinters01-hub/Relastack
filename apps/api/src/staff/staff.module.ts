import { Module } from '@nestjs/common';
import { StaffBillingService } from './staff-billing.service';
import { StaffController } from './staff.controller';
import { StaffGuard } from './staff.guard';
import { StaffService } from './staff.service';

@Module({
  controllers: [StaffController],
  providers: [StaffService, StaffBillingService, StaffGuard],
  exports: [StaffGuard],
})
export class StaffModule {}
