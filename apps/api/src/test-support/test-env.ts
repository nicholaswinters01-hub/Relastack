import { loadServerEnv, type ServerEnv } from '@platform/config';

/**
 * A fully-populated ServerEnv for unit tests.
 *
 * Built by running the real schema over a minimal input rather than by writing
 * out an object literal. Literals have to be updated in every spec each time a
 * setting is added — which broke three suites twice while building Phase 4 —
 * and, worse, they can drift from the real defaults and let a test pass
 * against configuration the application would never actually run with.
 *
 * @param overrides Raw values, exactly as they would appear in the environment.
 */
export function makeTestEnv(overrides: Record<string, string> = {}): ServerEnv {
  return loadServerEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    LOG_LEVEL: 'error',
    ...overrides,
  });
}
