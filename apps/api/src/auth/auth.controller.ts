import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  loginRequestSchema,
  registerRequestSchema,
  SESSION_COOKIE_NAME,
  type AuthResponse,
  type LoginRequest,
  type LogoutResponse,
  type PublicUser,
  type RegisterRequest,
} from '@platform/shared';
import type { User } from '@platform/db';
import { loadServerEnv } from '@platform/config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CookieService } from './cookie.service';
import { CurrentUser, Public } from './auth.decorators';
import { AllowNoOrganization } from '../tenancy/tenant.decorators';
import type { FastifyReply, FastifyRequest } from './fastify.types';
import type { SessionContext } from './session.service';

/**
 * Rate limits, read once when this module is first loaded.
 *
 * @Throttle is decorator metadata, evaluated when the class is defined —
 * before any dependency injection container exists — so these values cannot
 * come from an injected provider the way the rest of configuration does.
 */
const rateLimits = loadServerEnv();

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Authentication endpoints.
 *
 * Controllers handle transport only: read the request, call a service, shape
 * the response. Every rule about what makes a login valid lives in AuthService.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
  ) {}

  /**
   * Recorded for audit and for showing users their active sessions. Never
   * used to make authorization decisions — both values are trivially forged.
   */
  private contextOf(request: FastifyRequest): SessionContext {
    const userAgent = request.headers['user-agent'];

    return {
      ipAddress: request.ip,
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: rateLimits.RATE_LIMIT_REGISTER_PER_HOUR, ttl: HOUR } })
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const { user, session } = await this.auth.register(body, this.contextOf(request));

    // Registering signs you in. Requiring a separate login immediately after
    // is friction with no security benefit — the password was just proven.
    this.cookies.setSession(reply, session.token, session.expiresAt);

    return { user };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: rateLimits.RATE_LIMIT_LOGIN_PER_MINUTE, ttl: MINUTE } })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const { user, session } = await this.auth.login(body, this.contextOf(request));

    this.cookies.setSession(reply, session.token, session.expiresAt);

    return { user };
  }

  /**
   * Log out of the current session.
   *
   * Public because a request carrying an expired cookie must still be able to
   * clear it. Requiring authentication here would trap a user with a stale
   * session in a state where they cannot log out.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResponse> {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    const sessionsRevoked = token ? await this.auth.logout(token) : 0;

    this.cookies.clearSession(reply);

    return { success: true, sessionsRevoked };
  }

  /**
   * Revoke every session for the current user, including this one.
   *
   * This is the capability that justified sessions over JWTs — sign-out
   * everywhere takes effect on the very next request.
   */
  @AllowNoOrganization()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser() user: User,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResponse> {
    const sessionsRevoked = await this.auth.logoutAll(user.id);

    this.cookies.clearSession(reply);

    return { success: true, sessionsRevoked };
  }

  /**
   * The currently authenticated user.
   *
   * Org-optional on purpose: a user whose membership was removed must still be
   * able to see who they are and sign out, rather than being locked into a
   * state where every endpoint refuses them.
   */
  @AllowNoOrganization()
  @Get('me')
  me(@CurrentUser() user: User): { user: PublicUser } {
    return { user: AuthService.toPublicUser(user) };
  }
}
