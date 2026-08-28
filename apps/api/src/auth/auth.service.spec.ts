import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@platform/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_ENV } from '../config.provider';
import { makeTestEnv } from '../test-support/test-env';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/**
 * Reads the first argument of a mock's first call.
 *
 * Exists because `noUncheckedIndexedAccess` types `calls[0][0]` as possibly
 * undefined, which is correct but noisy at every assertion site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const firstArg = <T = Record<string, any>>(m: { mock: { calls: unknown[][] } }): T =>
  m.mock.calls[0]?.[0] as T;

const now = new Date('2026-08-27T00:00:00.000Z');

const testEnv = makeTestEnv({ LOGIN_MAX_FAILED_ATTEMPTS: '3', LOGIN_LOCKOUT_MINUTES: '15' });

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'nick@example.com',
    passwordHash: '$argon2id$fake',
    firstName: 'Nick',
    lastName: 'Winters',
    status: 'ACTIVE',
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const registration = {
  email: 'nick@example.com',
  password: 'a-very-long-password',
  organizationName: 'ABC Landscaping',
  firstName: undefined,
  lastName: undefined,
};

describe('AuthService', () => {
  let userFindUnique: ReturnType<typeof vi.fn>;
  let userCreate: ReturnType<typeof vi.fn>;
  let userUpdate: ReturnType<typeof vi.fn>;
  let withTenant: ReturnType<typeof vi.fn>;
  let createForOwner: ReturnType<typeof vi.fn>;
  let passwords: {
    hash: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    fakeVerify: ReturnType<typeof vi.fn>;
  };
  let sessions: {
    issue: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;

  beforeEach(async () => {
    userFindUnique = vi.fn();
    userCreate = vi.fn().mockResolvedValue(makeUser());
    userUpdate = vi.fn().mockImplementation(({ data }) => makeUser(data));
    createForOwner = vi.fn().mockResolvedValue({ id: 'org-id' });

    // Executes the callback with a stand-in transaction client, so the test
    // exercises the real body of register() rather than stubbing it out.
    withTenant = vi
      .fn()
      .mockImplementation((_context, work) => work({ user: { create: userCreate } }));

    passwords = {
      hash: vi.fn().mockResolvedValue('$argon2id$hashed'),
      verify: vi.fn().mockResolvedValue(true),
      fakeVerify: vi.fn().mockResolvedValue(false),
    };

    sessions = {
      issue: vi.fn().mockResolvedValue({ token: 'raw-token', expiresAt: now }),
      revoke: vi.fn().mockResolvedValue(1),
      revokeAllForUser: vi.fn().mockResolvedValue(3),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PasswordService, useValue: passwords },
        { provide: SessionService, useValue: sessions },
        { provide: OrganizationsService, useValue: { createForOwner } },
        { provide: SERVER_ENV, useValue: testEnv },
        {
          provide: PrismaService,
          useValue: {
            withTenant,
            client: {
              user: { findUnique: userFindUnique, create: userCreate, update: userUpdate },
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('toPublicUser', () => {
    it('never exposes the password hash', () => {
      const publicUser = AuthService.toPublicUser(makeUser() as never);

      expect(publicUser).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(publicUser)).not.toContain('argon2');
    });
  });

  describe('register', () => {
    it('hashes the password and never stores plaintext', async () => {
      await service.register(registration);

      expect(passwords.hash).toHaveBeenCalledWith('a-very-long-password');

      const created = firstArg(userCreate).data;
      expect(created.passwordHash).toBe('$argon2id$hashed');
      expect(JSON.stringify(created)).not.toContain('a-very-long-password');
    });

    it('creates the user and organization in one tenant-scoped transaction', async () => {
      await service.register(registration);

      // A user committed without an organization would be stranded:
      // authenticated, but unable to reach any business endpoint.
      expect(withTenant).toHaveBeenCalledOnce();
      expect(userCreate).toHaveBeenCalledOnce();
      expect(createForOwner).toHaveBeenCalledOnce();
    });

    it('establishes tenant context matching the ids it is about to insert', async () => {
      await service.register(registration);

      const context = firstArg(withTenant);
      const insertedUserId = firstArg(userCreate).data.id;
      const [, organizationId, ownerUserId, name] = createForOwner.mock.calls[0] as [
        unknown,
        string,
        string,
        string,
      ];

      // RLS WITH CHECK compares each new row against
      // app.current_organization_id, so context must be established before the
      // insert and must match it exactly.
      expect(context.organizationId).toBe(organizationId);
      expect(context.userId).toBe(insertedUserId);
      expect(ownerUserId).toBe(insertedUserId);
      expect(name).toBe('ABC Landscaping');
    });

    it('issues a session so registration signs the user in', async () => {
      const result = await service.register(registration);

      expect(sessions.issue).toHaveBeenCalledWith(makeUser().id, {});
      expect(result.session.token).toBe('raw-token');
    });

    it('translates a unique-constraint violation into a conflict', async () => {
      withTenant.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(service.register(registration)).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not swallow unrelated database errors', async () => {
      withTenant.mockRejectedValue(new Error('connection lost'));

      await expect(service.register(registration)).rejects.toThrow('connection lost');
    });

    it('does not issue a session when registration fails', async () => {
      withTenant.mockRejectedValue(new Error('connection lost'));

      await expect(service.register(registration)).rejects.toThrow();
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('returns the user and a session on valid credentials', async () => {
      userFindUnique.mockResolvedValue(makeUser());

      const result = await service.login({ email: 'nick@example.com', password: 'right' });

      expect(result.user.email).toBe('nick@example.com');
      expect(result.session.token).toBe('raw-token');
      expect(sessions.issue).toHaveBeenCalledOnce();
    });

    it('records the login time', async () => {
      userFindUnique.mockResolvedValue(makeUser());

      await service.login({ email: 'nick@example.com', password: 'right' });

      expect(userUpdate).toHaveBeenCalledOnce();
      expect(firstArg(userUpdate).data.lastLoginAt).toBeInstanceOf(Date);
    });

    it('rejects a wrong password without issuing a session', async () => {
      userFindUnique.mockResolvedValue(makeUser());
      passwords.verify.mockResolvedValue(false);

      await expect(
        service.login({ email: 'nick@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('burns equivalent CPU time when the email does not exist', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'whatever' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // Without this the endpoint becomes an account-enumeration oracle:
      // unknown emails would return in microseconds, known ones in ~3ms.
      expect(passwords.fakeVerify).toHaveBeenCalledOnce();
    });

    it('gives byte-identical errors for unknown email and wrong password', async () => {
      userFindUnique.mockResolvedValue(null);
      const unknownEmail = await service
        .login({ email: 'nobody@example.com', password: 'x' })
        .catch((error: Error) => error.message);

      userFindUnique.mockResolvedValue(makeUser());
      passwords.verify.mockResolvedValue(false);
      const wrongPassword = await service
        .login({ email: 'nick@example.com', password: 'x' })
        .catch((error: Error) => error.message);

      expect(unknownEmail).toBe(wrongPassword);
    });

    it('rejects a suspended account only after verifying the password', async () => {
      userFindUnique.mockResolvedValue(makeUser({ status: 'SUSPENDED' }));

      await expect(
        service.login({ email: 'nick@example.com', password: 'right' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // Order matters: reporting "suspended" to someone who guessed the email
      // but not the password would confirm the account exists.
      expect(passwords.verify).toHaveBeenCalledOnce();
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('uses the same message for a suspended account', async () => {
      userFindUnique.mockResolvedValue(makeUser({ status: 'SUSPENDED' }));

      const message = await service
        .login({ email: 'nick@example.com', password: 'right' })
        .catch((error: Error) => error.message);

      expect(message).toBe('Invalid email or password');
    });
  });

  describe('account lockout', () => {
    it('counts consecutive failures without locking below the threshold', async () => {
      userFindUnique.mockResolvedValue(makeUser({ failedLoginAttempts: 1 }));
      passwords.verify.mockResolvedValue(false);

      await expect(service.login({ email: 'nick@example.com', password: 'x' })).rejects.toThrow();

      const update = firstArg(userUpdate).data;
      expect(update.failedLoginAttempts).toBe(2);
      expect(update.lockedUntil).toBeUndefined();
    });

    it('locks the account once the threshold is reached', async () => {
      // Threshold is 3 in testEnv; this is the third consecutive failure.
      userFindUnique.mockResolvedValue(makeUser({ failedLoginAttempts: 2 }));
      passwords.verify.mockResolvedValue(false);

      await expect(service.login({ email: 'nick@example.com', password: 'x' })).rejects.toThrow();

      const update = firstArg(userUpdate).data;
      expect(update.failedLoginAttempts).toBe(3);
      expect(update.lockedUntil).toBeInstanceOf(Date);
    });

    it('locks for the configured window, not permanently', async () => {
      userFindUnique.mockResolvedValue(makeUser({ failedLoginAttempts: 2 }));
      passwords.verify.mockResolvedValue(false);

      await expect(service.login({ email: 'nick@example.com', password: 'x' })).rejects.toThrow();

      const lockedUntil = firstArg(userUpdate).data.lockedUntil as Date;
      const expected = Date.now() + testEnv.LOGIN_LOCKOUT_MINUTES * 60_000;

      // A permanent lock would hand an attacker a denial-of-service: knowing
      // someone's email would be enough to keep them out for good.
      expect(Math.abs(lockedUntil.getTime() - expected)).toBeLessThan(2_000);
    });

    it('refuses a locked account even with the correct password', async () => {
      userFindUnique.mockResolvedValue(makeUser({ lockedUntil: new Date(Date.now() + 60_000) }));
      passwords.verify.mockResolvedValue(true);

      await expect(
        service.login({ email: 'nick@example.com', password: 'right' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('still verifies the password before refusing a locked account', async () => {
      userFindUnique.mockResolvedValue(makeUser({ lockedUntil: new Date(Date.now() + 60_000) }));
      passwords.verify.mockResolvedValue(false);

      await expect(service.login({ email: 'nick@example.com', password: 'x' })).rejects.toThrow();

      // Short-circuiting on the lock would return in microseconds while an
      // unlocked account takes ~3ms, telling an attacker which addresses they
      // have successfully locked.
      expect(passwords.verify).toHaveBeenCalledOnce();
    });

    it('gives a locked account the same message as a wrong password', async () => {
      userFindUnique.mockResolvedValue(makeUser({ lockedUntil: new Date(Date.now() + 60_000) }));
      const locked = await service
        .login({ email: 'nick@example.com', password: 'right' })
        .catch((error: Error) => error.message);

      userFindUnique.mockResolvedValue(makeUser());
      passwords.verify.mockResolvedValue(false);
      const wrong = await service
        .login({ email: 'nick@example.com', password: 'x' })
        .catch((error: Error) => error.message);

      expect(locked).toBe(wrong);
      expect(locked).toBe('Invalid email or password');
    });

    it('treats an expired lock as no lock at all', async () => {
      userFindUnique.mockResolvedValue(
        makeUser({ lockedUntil: new Date(Date.now() - 1_000), failedLoginAttempts: 5 }),
      );

      const result = await service.login({ email: 'nick@example.com', password: 'right' });

      expect(result.session.token).toBe('raw-token');
    });

    it('clears the counter and the lock on a successful sign-in', async () => {
      userFindUnique.mockResolvedValue(makeUser({ failedLoginAttempts: 2 }));

      await service.login({ email: 'nick@example.com', password: 'right' });

      const update = firstArg(userUpdate).data;
      expect(update.failedLoginAttempts).toBe(0);
      expect(update.lockedUntil).toBeNull();
    });

    it('does not count failures against an address with no account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(service.login({ email: 'nobody@example.com', password: 'x' })).rejects.toThrow();

      // There is no row to lock, and pretending otherwise would leak whether
      // the address exists.
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the presented session', async () => {
      await expect(service.logout('raw-token')).resolves.toBe(1);
      expect(sessions.revoke).toHaveBeenCalledWith('raw-token');
    });

    it('revokes every session for a user', async () => {
      await expect(service.logoutAll('user-id')).resolves.toBe(3);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-id');
    });
  });
});
