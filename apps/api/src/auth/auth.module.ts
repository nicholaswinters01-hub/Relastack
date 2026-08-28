import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CookieService } from './cookie.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/**
 * Authentication.
 *
 * SessionService and CookieService are exported because AuthGuard — registered
 * globally in AppModule — depends on them.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, CookieService],
  exports: [AuthService, SessionService, CookieService, PasswordService],
})
export class AuthModule {}
