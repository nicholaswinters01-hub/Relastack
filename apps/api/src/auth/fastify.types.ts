import type { AuthenticatedSession } from './session.service';

/**
 * Minimal structural types for the parts of Fastify this application touches.
 *
 * Declaring `fastify` as a direct dependency in Phase 0 pulled in a second
 * copy at a different version from the one @nestjs/platform-fastify resolves,
 * and TypeScript treated the two `FastifyInstance` types as incompatible.
 * Structural types avoid the dependency entirely: they describe the shape we
 * rely on, and any Fastify version satisfying that shape works.
 *
 * The cookie members come from @fastify/cookie, registered in main.ts.
 */

export interface CookieSerializeOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
}

export interface FastifyRequest {
  cookies?: Record<string, string | undefined>;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Attached by AuthGuard once a request is authenticated. */
  session?: AuthenticatedSession;
}

export interface FastifyReply {
  setCookie(name: string, value: string, options?: CookieSerializeOptions): FastifyReply;
  clearCookie(name: string, options?: CookieSerializeOptions): FastifyReply;
}
