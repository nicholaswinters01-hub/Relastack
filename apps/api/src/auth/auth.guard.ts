import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import type { FastifyReply, FastifyRequest } from './fastify.types';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { SessionService } from './session.service';
import { CookieService } from './cookie.service';

/**
 * Authenticates every request unless the handler is marked `@Public()`.
 *
 * Registered globally in AppModule. Endpoints are protected by default; see
 * the note on the `Public` decorator for why that direction matters.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies?.[SESSION_COOKIE_NAME];

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const session = await this.sessions.validate(token);

    if (!session) {
      // The cookie is present but useless — expired, revoked, or unknown.
      // Clearing it stops the browser resending a dead token on every request.
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      this.cookies.clearSession(reply);
      throw new UnauthorizedException('Session is invalid or has expired');
    }

    // Record use, and extend the session if it is near expiry. When the expiry
    // moves, the cookie must move with it or the browser would discard a token
    // the server still considers valid.
    const renewedUntil = await this.sessions.touch(session);

    if (renewedUntil) {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      this.cookies.setSession(reply, token, renewedUntil);
    }

    request.session = session;

    return true;
  }
}
