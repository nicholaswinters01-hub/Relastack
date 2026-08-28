import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadServerEnv } from './index';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
};

describe('loadServerEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = loadServerEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadServerEnv({})).toThrow(ConfigValidationError);
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() => loadServerEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' })).toThrow(
      /must be a PostgreSQL connection string/,
    );
  });

  it('coerces API_PORT from a string and rejects out-of-range values', () => {
    expect(loadServerEnv({ ...validEnv, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => loadServerEnv({ ...validEnv, API_PORT: '99999' })).toThrow(ConfigValidationError);
    expect(() => loadServerEnv({ ...validEnv, API_PORT: 'not-a-port' })).toThrow(
      ConfigValidationError,
    );
  });

  it('parses CORS_ORIGINS into a trimmed list and rejects malformed origins', () => {
    const env = loadServerEnv({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:3000, https://app.example.com',
    });

    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'https://app.example.com']);
    expect(() => loadServerEnv({ ...validEnv, CORS_ORIGINS: 'not-a-url' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects an unrecognised NODE_ENV', () => {
    expect(() => loadServerEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(
      ConfigValidationError,
    );
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadServerEnv({ NODE_ENV: 'staging', API_PORT: 'abc' });
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('loadServerEnv — session and rate-limit settings', () => {
  it('applies session defaults', () => {
    const env = loadServerEnv(validEnv);

    expect(env.SESSION_TTL_DAYS).toBe(7);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.RATE_LIMIT_LOGIN_PER_MINUTE).toBe(5);
    expect(env.RATE_LIMIT_REGISTER_PER_HOUR).toBe(10);
    expect(env.RATE_LIMIT_GLOBAL_PER_MINUTE).toBe(120);
  });

  it('parses COOKIE_SECURE from a string', () => {
    expect(loadServerEnv({ ...validEnv, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(loadServerEnv({ ...validEnv, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('refuses to start in production without a secure cookie', () => {
    expect(() =>
      loadServerEnv({ ...validEnv, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE must be true when NODE_ENV=production/);
  });

  it('allows production when the cookie is secure', () => {
    const env = loadServerEnv({
      ...validEnv,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL_APP: 'postgresql://app:pass@localhost:5432/db',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('rejects a non-positive session lifetime', () => {
    expect(() => loadServerEnv({ ...validEnv, SESSION_TTL_DAYS: '0' })).toThrow(
      ConfigValidationError,
    );
    expect(() => loadServerEnv({ ...validEnv, SESSION_TTL_DAYS: '-1' })).toThrow(
      ConfigValidationError,
    );
  });
});

describe('loadServerEnv — production safety rules', () => {
  it('defaults rate limiting to enabled', () => {
    expect(loadServerEnv(validEnv).RATE_LIMIT_ENABLED).toBe(true);
  });

  it('allows rate limiting to be disabled outside production', () => {
    const env = loadServerEnv({ ...validEnv, RATE_LIMIT_ENABLED: 'false' });

    expect(env.RATE_LIMIT_ENABLED).toBe(false);
  });

  it('refuses to start in production with rate limiting disabled', () => {
    // An unthrottled login endpoint is both a credential-stuffing target and,
    // because Argon2 is deliberately expensive, a denial-of-service vector.
    expect(() =>
      loadServerEnv({
        ...validEnv,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        RATE_LIMIT_ENABLED: 'false',
      }),
    ).toThrow(/RATE_LIMIT_ENABLED must be true when NODE_ENV=production/);
  });

  it('accepts a fully valid production configuration', () => {
    const env = loadServerEnv({
      ...validEnv,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      RATE_LIMIT_ENABLED: 'true',
      DATABASE_URL_APP: 'postgresql://app:pass@localhost:5432/db',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });
});

describe('loadServerEnv — application database role', () => {
  const productionBase = {
    ...validEnv,
    NODE_ENV: 'production',
    COOKIE_SECURE: 'true',
    RATE_LIMIT_ENABLED: 'true',
  };

  it('allows DATABASE_URL_APP to be omitted outside production', () => {
    expect(loadServerEnv(validEnv).DATABASE_URL_APP).toBeUndefined();
  });

  it('refuses to start in production without DATABASE_URL_APP', () => {
    // The migration role is a superuser, and PostgreSQL exempts superusers
    // from row-level security. Serving requests as it would leave every policy
    // in place and isolating nothing.
    expect(() => loadServerEnv(productionBase)).toThrow(/DATABASE_URL_APP must be set/);
  });

  it('refuses to start in production when the app role equals the migration role', () => {
    expect(() =>
      loadServerEnv({ ...productionBase, DATABASE_URL_APP: productionBase.DATABASE_URL }),
    ).toThrow(/different from DATABASE_URL/);
  });

  it('accepts a distinct application role in production', () => {
    const env = loadServerEnv({
      ...productionBase,
      DATABASE_URL_APP: 'postgresql://platform_app:secret@localhost:5432/db',
    });

    expect(env.DATABASE_URL_APP).toBe('postgresql://platform_app:secret@localhost:5432/db');
    expect(env.DATABASE_URL_APP).not.toBe(env.DATABASE_URL);
  });

  it('rejects a non-PostgreSQL application connection string', () => {
    expect(() =>
      loadServerEnv({ ...validEnv, DATABASE_URL_APP: 'mysql://app:pass@localhost:3306/db' }),
    ).toThrow(ConfigValidationError);
  });
});
