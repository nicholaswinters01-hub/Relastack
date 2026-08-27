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
