import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id, with the parameters OWASP currently recommends: 19 MiB of memory,
 * 2 iterations, 1 degree of parallelism. Argon2id is chosen over bcrypt
 * because its memory cost makes GPU and ASIC cracking dramatically more
 * expensive per guess.
 *
 * Parameters live here as named constants rather than inline magic numbers so
 * that raising them later is a one-line, reviewable change. Argon2 encodes the
 * parameters into the hash string itself, so raising them does not invalidate
 * existing hashes — old passwords keep verifying against their original cost.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A pre-computed hash used to burn equivalent CPU time when a login is
 * attempted for an email that does not exist. See `fakeVerify`.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$JisQJEjdtWncG2UtipaX/Q$6UD4PLESokxI3Rddgoe84GxK8ydfRTWBXWW9NhoIkhw';

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verify a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash. A corrupted row
   * should deny access, not surface a 500 that tells an attacker something
   * unusual happened to this particular account.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /**
   * Burn roughly the same CPU time as a real verification, then fail.
   *
   * Without this, a login for an unknown email returns in microseconds while a
   * login for a known email takes ~15ms. That difference is measurable over a
   * few requests and turns the login endpoint into an account-enumeration
   * oracle — which is precisely what the generic error message exists to
   * prevent.
   */
  async fakeVerify(): Promise<false> {
    try {
      await verify(DUMMY_HASH, 'timing-equalisation', ARGON2_OPTIONS);
    } catch {
      // Expected: the dummy hash never matches. The point is the elapsed time.
    }
    return false;
  }
}
