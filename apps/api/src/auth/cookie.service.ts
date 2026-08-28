import { Inject, Injectable } from '@nestjs/common';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import type { CookieSerializeOptions, FastifyReply } from './fastify.types';

/**
 * Owns how the session cookie is written and cleared.
 *
 * One place decides the security flags. Scattering `setCookie` calls across
 * controllers is how a cookie ends up missing `httpOnly` on one code path.
 */
@Injectable()
export class CookieService {
  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {}

  private baseOptions(): CookieSerializeOptions {
    return {
      // Unreadable from JavaScript, so an XSS flaw cannot exfiltrate the
      // session token.
      httpOnly: true,

      // HTTPS only. Config refuses to start in production without this.
      secure: this.env.COOKIE_SECURE,

      // 'lax' lets the cookie ride ordinary top-level navigations (following a
      // link into the app keeps you logged in) while withholding it from
      // cross-site POSTs, which blocks the classic CSRF shape. 'strict' would
      // log users out whenever they arrive from an external link.
      sameSite: 'lax',

      path: '/',
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
    };
  }

  setSession(reply: FastifyReply, token: string, expiresAt: Date): void {
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      ...this.baseOptions(),
      expires: expiresAt,
    });
  }

  /**
   * Clear the session cookie.
   *
   * The options must match those used when setting it — browsers treat a
   * cookie's identity as name plus path plus domain, so a mismatch leaves the
   * original cookie in place and the user apparently still logged in.
   */
  clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE_NAME, this.baseOptions());
  }
}
