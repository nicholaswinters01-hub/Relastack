import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Thrown when a sealed value cannot be opened. Never carries the value. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Encrypts the OAuth grants businesses give RelaStack.
 *
 * AES-256-GCM with a key that lives in the environment, never the database: a
 * copy of the database alone reveals nobody's DocuSign. Every value is sealed
 * to a `binding` (the business, the provider and what it is), used as the
 * cipher's authenticated data. A sealed token copied onto another business's
 * row therefore fails to open instead of quietly working for them.
 *
 * Sealed form: `v<version>.<iv>.<tag>.<ciphertext>`, base64url. The highest
 * key version seals; every configured version opens, so keys can be rotated.
 */
export class TokenVault {
  private readonly current: number | null;

  constructor(private readonly keys: ReadonlyMap<number, Buffer> | undefined) {
    this.current = keys && keys.size > 0 ? Math.max(...keys.keys()) : null;
  }

  /** Whether any key is configured. Without one, nothing can be connected. */
  get available(): boolean {
    return this.current !== null;
  }

  seal(plaintext: string, binding: string): string {
    if (this.current === null || !this.keys)
      throw new VaultError('No encryption key is configured');
    const key = this.keys.get(this.current)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(binding, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      `v${this.current}`,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(sealed: string, binding: string): string {
    const parts = sealed.split('.');
    const version = /^v(\d+)$/.exec(parts[0] ?? '')?.[1];
    if (parts.length !== 4 || version === undefined) throw new VaultError('Not a sealed value');

    const key = this.keys?.get(Number(version));
    if (!key) throw new VaultError(`No key for version ${version}`);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts[1]!, 'base64url'));
      decipher.setAAD(Buffer.from(binding, 'utf8'));
      decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, wrong binding, or tampered: all the same answer, and never
      // the value itself.
      throw new VaultError('The sealed value could not be opened');
    }
  }

  /** Sealed under an older key, so due for re-sealing. */
  isStale(sealed: string): boolean {
    return this.current !== null && sealed.split('.')[0] !== `v${this.current}`;
  }
}
