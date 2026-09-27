import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { LoginRequest, PublicUser, RegisterRequest } from '@platform/shared';
import { Prisma, type User } from '@platform/db';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession, type SessionContext } from './session.service';

/**
 * Deliberately identical for every login failure — unknown email, wrong
 * password, or suspended account. Distinguishing them would let anyone with a
 * login form enumerate which addresses hold accounts.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

export interface AuthResult {
  user: PublicUser;
  session: IssuedSession;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly organizations: OrganizationsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /**
   * Strip a user row down to what is safe to send over the wire.
   *
   * Every path that returns a user goes through here, so `passwordHash` cannot
   * escape by someone forgetting to omit it at one call site.
   */
  static toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Invite-only sign-up, when the deployment asks for it.
   *
   * Checked before the password is hashed, so a wrong code costs nothing. The
   * answer is the same field error whether the code is missing or wrong, and
   * the comparison takes the same time either way.
   */
  private assertAccessCode(given: string | undefined): void {
    const expected = this.env.SIGNUP_ACCESS_CODE;
    if (!expected || this.env.SIGNUP_OPEN) return;

    const a = Buffer.from(given ?? '');
    const b = Buffer.from(expected);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ field: 'accessCode', message: 'That access code is not valid' }],
      });
    }
  }

  /**
   * Register a new account, which creates a new business.
   *
   * Self-registration always means an owner signing their company up.
   * Employees are invited into an existing organization instead (Phase 4), so
   * there is no path here that joins one.
   *
   * User, organization, and owner membership are created in a single
   * transaction: a user who committed without an organization would be
   * stranded, authenticated but unable to reach any business endpoint.
   *
   * Both UUIDs are generated here rather than by the database because tenant
   * context must be established BEFORE the inserts — the RLS WITH CHECK
   * clauses compare each new row against `app.current_organization_id`, which
   * cannot reference a value the database has not produced yet.
   */
  async register(input: RegisterRequest, context: SessionContext = {}): Promise<AuthResult> {
    this.assertAccessCode(input.accessCode);

    const passwordHash = await this.passwords.hash(input.password);

    const userId = randomUUID();
    const organizationId = randomUUID();

    let user: User;

    try {
      user = await this.prisma.withTenant({ organizationId, userId }, async (tx) => {
        const created = await tx.user.create({
          data: {
            id: userId,
            email: input.email,
            passwordHash,
            firstName: input.firstName ?? null,
            lastName: input.lastName ?? null,
          },
        });

        await this.organizations.createForOwner(tx, organizationId, userId, input.organizationName);

        return created;
      });
    } catch (error) {
      // Relying on the unique constraint rather than a pre-check avoids the
      // race where two simultaneous registrations both see "email is free".
      // The database is the only arbiter that cannot be raced.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with that email already exists');
      }
      throw error;
    }

    this.logger.log(`User registered: ${user.id} (organization ${organizationId})`);

    const session = await this.sessions.issue(user.id, context);

    return { user: AuthService.toPublicUser(user), session };
  }

  async login(input: LoginRequest, context: SessionContext = {}): Promise<AuthResult> {
    const user = await this.prisma.client.user.findUnique({ where: { email: input.email } });

    // Burn equivalent CPU time so response latency cannot reveal whether the
    // address is registered. See PasswordService.fakeVerify.
    if (!user) {
      await this.passwords.fakeVerify();
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Locked accounts still run a full password verification before being
    // refused. Short-circuiting here would return in microseconds while an
    // unlocked account takes ~3ms, and that difference tells an attacker which
    // addresses they have successfully locked — turning the defence into an
    // enumeration oracle.
    const isLocked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();

    const passwordMatches = await this.passwords.verify(user.passwordHash, input.password);

    if (isLocked) {
      this.logger.warn(`Login attempt on locked account ${user.id}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!passwordMatches) {
      await this.recordFailedLogin(user);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Checked only AFTER the password is verified. Reporting "account
    // suspended" to someone who guessed the email but not the password would
    // confirm the account exists.
    if (user.status !== 'ACTIVE') {
      this.logger.warn(`Login attempt on non-active account ${user.id} (${user.status})`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const [session, updated] = await Promise.all([
      this.sessions.issue(user.id, context),
      this.prisma.client.user.update({
        where: { id: user.id },
        // A correct password clears the counter. Lockout counts CONSECUTIVE
        // failures, so someone who mistypes twice then succeeds starts clean.
        data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
      }),
    ]);

    this.logger.log(`User logged in: ${user.id}`);

    return { user: AuthService.toPublicUser(updated), session };
  }

  /**
   * Count a failed sign-in and lock the account once the threshold is crossed.
   *
   * This exists because rate limiting alone is per-IP, and credential stuffing
   * in the wild rotates addresses specifically to defeat that. Counting per
   * account is what actually stops a distributed attempt.
   *
   * The lock is time-bounded rather than requiring an administrator, because a
   * permanent lock would hand attackers a denial-of-service: knowing someone's
   * email address would be enough to keep them out indefinitely.
   */
  private async recordFailedLogin(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const threshold = this.env.LOGIN_MAX_FAILED_ATTEMPTS;
    const shouldLock = attempts >= threshold;

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        ...(shouldLock
          ? { lockedUntil: new Date(Date.now() + this.env.LOGIN_LOCKOUT_MINUTES * 60_000) }
          : {}),
      },
    });

    if (shouldLock) {
      // Worth alerting on in Phase 11: a burst of these across many accounts
      // is what a credential-stuffing run looks like from the inside.
      this.logger.warn(
        `Account ${user.id} locked for ${this.env.LOGIN_LOCKOUT_MINUTES}m after ${attempts} failed attempts`,
      );
    } else {
      this.logger.warn(`Failed login attempt ${attempts}/${threshold} for user ${user.id}`);
    }
  }

  async logout(token: string): Promise<number> {
    return this.sessions.revoke(token);
  }

  async logoutAll(userId: string): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId);
    this.logger.log(`Revoked ${count} session(s) for user ${userId}`);
    return count;
  }
}
