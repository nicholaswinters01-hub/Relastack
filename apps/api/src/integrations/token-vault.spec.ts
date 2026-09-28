import { describe, expect, it } from 'vitest';
import { TokenVault, VaultError } from './token-vault';

const key = (byte: number) => Buffer.alloc(32, byte);
const vault = (entries: Array<[number, number]>) =>
  new TokenVault(new Map(entries.map(([version, byte]) => [version, key(byte)])));

describe('TokenVault', () => {
  it('opens what it sealed, for the same binding', () => {
    const v = vault([[1, 7]]);
    const sealed = v.seal('secret-refresh-token', 'org-a:docusign:refresh');

    expect(sealed).not.toContain('secret-refresh-token');
    expect(v.open(sealed, 'org-a:docusign:refresh')).toBe('secret-refresh-token');
  });

  it('seals the same value differently every time', () => {
    const v = vault([[1, 7]]);
    expect(v.seal('same', 'b')).not.toBe(v.seal('same', 'b'));
  });

  it('refuses to open a value copied to another business', () => {
    const v = vault([[1, 7]]);
    const sealed = v.seal('secret', 'org-a:docusign:refresh');

    expect(() => v.open(sealed, 'org-b:docusign:refresh')).toThrow(VaultError);
    // Nor as a different kind of secret for the same business.
    expect(() => v.open(sealed, 'org-a:docusign:access')).toThrow(VaultError);
  });

  it('refuses a tampered value', () => {
    const v = vault([[1, 7]]);
    const [version, iv, tag, body] = v.seal('secret', 'b').split('.');
    const flipped = `${body!.slice(0, -2)}${body!.endsWith('A') ? 'B' : 'A'}${body!.slice(-1)}`;

    expect(() => v.open([version, iv, tag, flipped].join('.'), 'b')).toThrow(VaultError);
  });

  it('fails loudly with the wrong key rather than returning garbage', () => {
    const sealed = vault([[1, 7]]).seal('secret', 'b');
    expect(() => vault([[1, 8]]).open(sealed, 'b')).toThrow(VaultError);
  });

  it('seals with the newest key and still opens older ones, for rotation', () => {
    const old = vault([[1, 7]]).seal('secret', 'b');
    const rotated = vault([
      [1, 7],
      [2, 9],
    ]);

    expect(rotated.open(old, 'b')).toBe('secret');
    expect(rotated.isStale(old)).toBe(true);
    const fresh = rotated.seal('secret', 'b');
    expect(fresh.startsWith('v2.')).toBe(true);
    expect(rotated.isStale(fresh)).toBe(false);
  });

  it('refuses to seal with no key configured, and says it is unavailable', () => {
    const none = new TokenVault(undefined);
    expect(none.available).toBe(false);
    expect(() => none.seal('secret', 'b')).toThrow(VaultError);
  });

  it('never puts the secret in an error message', () => {
    const v = vault([[1, 7]]);
    const sealed = v.seal('do-not-leak-me', 'b');
    try {
      v.open(sealed, 'other');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('do-not-leak-me');
    }
  });
});
