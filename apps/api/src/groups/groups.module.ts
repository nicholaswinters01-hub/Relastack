import { Module } from '@nestjs/common';
import { GroupsController, MemberGroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/** Employee groups: labels for organising people. Core, and powerless by design. */
@Module({
  controllers: [GroupsController, MemberGroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
