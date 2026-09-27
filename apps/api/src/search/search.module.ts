import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { LocationsModule } from '../locations/locations.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TasksModule } from '../tasks/tasks.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** Quick search: a front door to the other modules' own list services. */
@Module({
  imports: [CrmModule, SchedulingModule, TasksModule, LocationsModule, OrganizationsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
