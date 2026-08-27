import { loadServerEnv, type ServerEnv } from '@platform/config';

/**
 * Injection token for validated server configuration.
 *
 * Using a token rather than importing `loadServerEnv()` directly at call sites
 * means tests can supply a fabricated configuration without touching the real
 * process environment.
 */
export const SERVER_ENV = Symbol('SERVER_ENV');

export const serverEnvProvider = {
  provide: SERVER_ENV,
  useFactory: (): ServerEnv => loadServerEnv(),
};

export type { ServerEnv };
