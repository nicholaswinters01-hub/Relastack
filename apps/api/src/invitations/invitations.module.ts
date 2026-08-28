import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Imports AuthModule for SessionService, CookieService and PasswordService:
 * accepting an invitation creates an account and signs the person in, which is
 * the same machinery registration uses.
 */
@Module({
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
