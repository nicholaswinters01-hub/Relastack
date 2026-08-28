import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an argon2id hash, never the plaintext', async () => {
    const hash = await service.hash('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('salts each hash, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);

    // Without a per-hash salt, identical passwords would produce identical
    // hashes and a single rainbow table would break every matching account.
    expect(a).not.toBe(b);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct horse battery staple');

    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct horse battery staple');

    await expect(service.verify(hash, 'wrong password entirely')).resolves.toBe(false);
    await expect(service.verify(hash, 'correct horse battery stapl')).resolves.toBe(false);
    await expect(service.verify(hash, '')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A corrupted row must deny access quietly, not surface a 500 that signals
    // something unusual about this particular account.
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(service.verify('', 'anything')).resolves.toBe(false);
  });

  it('fakeVerify returns false and does real work', async () => {
    // The point of fakeVerify is elapsed time. If the embedded dummy hash were
    // malformed it would throw instantly, and login timing would once again
    // reveal which emails exist.
    const started = Date.now();
    const result = await service.fakeVerify();
    const elapsed = Date.now() - started;

    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThan(0);
  });

  it('fakeVerify takes time comparable to a genuine failed verification', async () => {
    const hash = await service.hash('some-real-password');

    const realStart = Date.now();
    await service.verify(hash, 'wrong-password');
    const realElapsed = Date.now() - realStart;

    const fakeStart = Date.now();
    await service.fakeVerify();
    const fakeElapsed = Date.now() - fakeStart;

    // Generous bounds — this asserts the same order of magnitude, not a precise
    // match, so the test does not flake on a loaded CI runner.
    expect(fakeElapsed).toBeGreaterThan(realElapsed / 10);
    expect(fakeElapsed).toBeLessThan(realElapsed * 10 + 50);
  });
});
