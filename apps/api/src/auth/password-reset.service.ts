import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PASSWORD_RESET_TTL_MINUTES } from '@platform/shared';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { EmailService } from '../notifications/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';

const TOKEN_BYTES = 32;
/** One email a minute per person, however often the form is submitted. */
const RESEND_INTERVAL_MS = 60_000;

/** The same words for unknown, used and expired links, so none can be told apart. */
const INVALID_LINK = 'This link has expired or has already been used. Ask for a new one.';

/**
 * "Forgot password".
 *
 * Asking for a link answers the same way whether or not the address has an
 * account, so the form cannot be used to find out who is a customer. The link
 * is emailed, lasts an hour, works once, and only its hash is stored.
 *
 * Using it signs the person out everywhere: someone resetting a password may
 * be doing it because somebody else got in.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async requestReset(email: string, requestedIp?: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });

    // Suspended accounts get nothing: a reset must not become a way back in.
    if (!user || user.status !== 'ACTIVE') return;

    const now = Date.now();
    const recent = await this.prisma.client.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(now - RESEND_INTERVAL_MS) } },
      select: { id: true },
    });
    if (recent) return;

    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.prisma.client.$transaction([
      // Only the newest link works. An older one sitting in an inbox is one
      // more thing to steal.
      this.prisma.client.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date(now) },
      }),
      this.prisma.client.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: PasswordResetService.hash(token),
          expiresAt: new Date(now + PASSWORD_RESET_TTL_MINUTES * 60_000),
          requestedIp: requestedIp ?? null,
        },
      }),
    ]);

    // Not awaited: a slow or failing mail provider must neither delay the
    // answer nor turn it into an error that only real accounts produce.
    this.email
      .send({
        to: user.email,
        subject: 'Reset your RelaStack password',
        body:
          'Someone, hopefully you, asked to reset the password for your RelaStack account. ' +
          `Follow the link below to choose a new one. It works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes.\n\n` +
          'If you did not ask for this, ignore this email. Your password stays as it is.',
        link: `${this.env.APP_URL}/reset-password?token=${token}`,
      })
      .catch((error) =>
        this.logger.error(`Could not email a reset link to user ${user.id}`, error),
      );

    this.logger.log(`Password reset link issued for user ${user.id}`);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const now = new Date();
    const row = await this.prisma.client.passwordResetToken.findUnique({
      where: { tokenHash: PasswordResetService.hash(token) },
      include: { user: true },
    });

    if (!row || row.usedAt || row.expiresAt <= now || row.user.status !== 'ACTIVE') {
      throw new BadRequestException(INVALID_LINK);
    }

    if (password.toLowerCase() === row.user.email.toLowerCase()) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ field: 'password', message: 'Password must not be your email address' }],
      });
    }

    const passwordHash = await this.passwords.hash(password);

    await this.prisma.client.$transaction(async (tx) => {
      // Claimed conditionally, so two tabs submitting the same link cannot
      // both succeed.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw new BadRequestException(INVALID_LINK);

      await tx.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null },
        data: { usedAt: now },
      });

      await tx.user.update({
        where: { id: row.userId },
        // A forgotten password is often what caused the lockout.
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });

      await tx.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    this.email
      .send({
        to: row.user.email,
        subject: 'Your RelaStack password was changed',
        body:
          'The password for your RelaStack account was just changed, and every device that ' +
          'was signed in has been signed out.\n\n' +
          'If this was not you, reset it again straight away using the link below, and ' +
          'email hello@relastack.com so we can help.',
        link: `${this.env.APP_URL}/forgot-password`,
      })
      .catch((error) =>
        this.logger.error(`Could not email a password-changed notice to user ${row.userId}`, error),
      );

    this.logger.log(`Password reset for user ${row.userId}; all sessions revoked`);
  }
}
