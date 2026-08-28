import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Session, User } from '@platform/db';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 32 bytes = 256 bits of entropy. Guessing a valid token is not a realistic
 * attack at this size, which is why these tokens do not need slow hashing the
 * way human-chosen passwords do.
 */
const TOKEN_BYTES = 32;

/**
 * Renew a session when less than half its lifetime remains.
 *
 * Without renewal, an active user is logged out mid-work every SESSION_TTL_DAYS.
 * Renewing on every request would mean a database write per request, so the
 * halfway threshold gets the UX benefit at a fraction of the cost.
 */
const RENEWAL_THRESHOLD = 0.5;

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedSession {
  /** The raw token. Returned exactly once — it is never recoverable later. */
  token: string;
  expiresAt: Date;
}

export type AuthenticatedSession = Session & { user: User };

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /**
   * Hash a session token for storage and lookup.
   *
   * SHA-256, deliberately, not Argon2. Argon2 is slow *by design* to make
   * guessing human-chosen passwords expensive. A 256-bit random token cannot
   * be guessed, so slowness would buy no security while adding latency to
   * every authenticated request. Storing the hash still means a leaked
   * database grants an attacker no usable sessions.
   *
   * SHA-256 is also deterministic, which is what makes an indexed lookup by
   * token possible at all — Argon2's per-hash salt would force a table scan.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlMs(): number {
    return this.env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  /**
   * Create a new session for a user.
   *
   * A fresh token is generated on every call — tokens are never reused across
   * authentications, which is what prevents session fixation.
   */
  async issue(userId: string, context: SessionContext = {}): Promise<IssuedSession> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs());

    await this.prisma.client.session.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent?.slice(0, 500),
      },
    });

    return { token, expiresAt };
  }

  /**
   * Resolve a raw token to its session and user, or null.
   *
   * Returns null for every failure mode — unknown, expired, revoked, or
   * belonging to a suspended user. The caller cannot distinguish between them,
   * and should not: to an unauthenticated client they are all simply
   * "not authenticated".
   */
  async validate(token: string): Promise<AuthenticatedSession | null> {
    if (!token) return null;

    const session = await this.prisma.client.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });

    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    if (session.user.status !== 'ACTIVE') return null;

    return session;
  }

  /**
   * Record use of a session and extend it if it is past the renewal threshold.
   *
   * Returns the new expiry when renewed, so the caller can refresh the cookie
   * to match. Returns null when no renewal was needed.
   */
  async touch(session: Session): Promise<Date | null> {
    const ttl = this.ttlMs();
    const remaining = session.expiresAt.getTime() - Date.now();
    const shouldRenew = remaining < ttl * RENEWAL_THRESHOLD;

    const expiresAt = shouldRenew ? new Date(Date.now() + ttl) : undefined;

    await this.prisma.client.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), ...(expiresAt ? { expiresAt } : {}) },
    });

    return expiresAt ?? null;
  }

  /** Revoke one session by its raw token. Idempotent. */
  async revoke(token: string): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { tokenHash: this.hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return result.count;
  }

  /**
   * Revoke every active session for a user.
   *
   * This is the capability that justified choosing sessions over JWTs: access
   * ends the instant this runs. From Phase 4 it also backs administrative
   * termination of a user's access.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return result.count;
  }

  /**
   * Delete expired and revoked sessions.
   *
   * Not scheduled yet — invoked manually or by tests. Phase 11 introduces the
   * background job runner that will call this on a timer.
   */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.client.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }] },
    });

    return result.count;
  }
}
