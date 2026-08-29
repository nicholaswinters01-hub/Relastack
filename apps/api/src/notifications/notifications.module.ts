import { Global, Module } from '@nestjs/common';
import { DispatcherService } from './dispatcher.service';
import { EmailService } from './email.service';
import { EventsService } from './events.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { SweepsService } from './sweeps.service';
import { SchedulingModule } from '../scheduling/scheduling.module';

/**
 * Events and notifications (Phase 11).
 *
 * Global, because every business module needs to emit events and none of them
 * should have to import this one to do it. The dependency runs one way: a
 * module records that something happened, and knows nothing about who is told.
 */
@Global()
@Module({
  imports: [SchedulingModule],
  controllers: [NotificationsController],
  providers: [EventsService, NotificationsService, EmailService, DispatcherService, SweepsService],
  exports: [EventsService, NotificationsService, EmailService, DispatcherService, SweepsService],
})
export class NotificationsModule {}
