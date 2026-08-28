import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_ENV } from '../config.provider';
import { makeTestEnv } from '../test-support/test-env';
import { PrismaService } from '../prisma/prisma.service';
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

const testEnv = makeTestEnv();

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('SessionService', () => {
  let create: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let updateMany: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;
  let service: SessionService;

  beforeEach(async () => {
    create = vi.fn().mockResolvedValue({});
    findUnique = vi.fn();
    update = vi.fn().mockResolvedValue({});
    updateMany = vi.fn().mockResolvedValue({ count: 1 });
    deleteMany = vi.fn().mockResolvedValue({ count: 4 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: SERVER_ENV, useValue: testEnv },
        {
          provide: PrismaService,
          useValue: {
            client: { session: { create, findUnique, update, updateMany, deleteMany } },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(SessionService);
  });

  describe('issue', () => {
    it('stores only the hash of the token, never the token', async () => {
      const { token } = await service.issue('user-1');

      const stored = firstArg(create).data;

      expect(stored.tokenHash).toBe(sha256(token));
      expect(stored.tokenHash).not.toBe(token);
      // A leaked database dump must grant no usable sessions.
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('generates a high-entropy token', async () => {
      const { token } = await service.issue('user-1');

      // 32 random bytes in base64url — 43 characters, no padding.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('never reuses a token across sessions', async () => {
      const first = await service.issue('user-1');
      const second = await service.issue('user-1');

      // A reused token is session fixation.
      expect(first.token).not.toBe(second.token);
    });

    it('sets expiry from the configured lifetime', async () => {
      const { expiresAt } = await service.issue('user-1');
      const expected = Date.now() + testEnv.SESSION_TTL_DAYS * DAY;

      expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(2_000);
    });

    it('truncates an overlong user agent rather than failing', async () => {
      await service.issue('user-1', { userAgent: 'x'.repeat(2_000) });

      expect(firstArg(create).data.userAgent).toHaveLength(500);
    });
  });

  describe('validate', () => {
    const activeSession = (overrides: Record<string, unknown> = {}) => ({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3 * DAY),
      revokedAt: null,
      user: { id: 'user-1', status: 'ACTIVE' },
      ...overrides,
    });

    it('looks a session up by token hash, not the raw token', async () => {
      findUnique.mockResolvedValue(activeSession());

      await service.validate('some-token');

      expect(firstArg(findUnique).where.tokenHash).toBe(sha256('some-token'));
    });

    it('resolves a valid session', async () => {
      findUnique.mockResolvedValue(activeSession());

      await expect(service.validate('some-token')).resolves.not.toBeNull();
    });

    it('rejects an empty token without hitting the database', async () => {
      await expect(service.validate('')).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.validate('bogus')).resolves.toBeNull();
    });

    it('rejects an expired session', async () => {
      findUnique.mockResolvedValue(activeSession({ expiresAt: new Date(Date.now() - 1_000) }));

      await expect(service.validate('some-token')).resolves.toBeNull();
    });

    it('rejects a revoked session', async () => {
      findUnique.mockResolvedValue(activeSession({ revokedAt: new Date() }));

      // This is the property that justified sessions over JWTs.
      await expect(service.validate('some-token')).resolves.toBeNull();
    });

    it('rejects a session belonging to a suspended user', async () => {
      findUnique.mockResolvedValue(activeSession({ user: { id: 'user-1', status: 'SUSPENDED' } }));

      // Suspension must take effect immediately, not at session expiry.
      await expect(service.validate('some-token')).resolves.toBeNull();
    });
  });

  describe('touch', () => {
    it('records use without extending a fresh session', async () => {
      const session = {
        id: 'session-1',
        expiresAt: new Date(Date.now() + 6 * DAY),
      };

      const renewed = await service.touch(session as never);

      expect(renewed).toBeNull();
      expect(firstArg(update).data.lastUsedAt).toBeInstanceOf(Date);
      expect(firstArg(update).data.expiresAt).toBeUndefined();
    });

    it('extends a session past the halfway point of its lifetime', async () => {
      const session = {
        id: 'session-1',
        expiresAt: new Date(Date.now() + 2 * DAY),
      };

      const renewed = await service.touch(session as never);

      expect(renewed).toBeInstanceOf(Date);
      expect(renewed?.getTime() ?? 0).toBeGreaterThan(Date.now() + 6 * DAY);
    });
  });

  describe('revocation', () => {
    it('revokes by token hash and ignores already-revoked rows', async () => {
      await expect(service.revoke('some-token')).resolves.toBe(1);

      expect(firstArg(updateMany).where).toEqual({
        tokenHash: sha256('some-token'),
        revokedAt: null,
      });
    });

    it('revokes every active session for a user', async () => {
      updateMany.mockResolvedValue({ count: 5 });

      await expect(service.revokeAllForUser('user-1')).resolves.toBe(5);
      expect(firstArg(updateMany).where).toEqual({ userId: 'user-1', revokedAt: null });
    });

    it('purges expired and revoked sessions', async () => {
      await expect(service.purgeExpired()).resolves.toBe(4);
      expect(deleteMany).toHaveBeenCalledOnce();
    });
  });
});
