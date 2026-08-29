/**
 * Shared API contracts.
 *
 * Contracts are Zod schemas rather than bare TypeScript types so that a single
 * definition both checks at build time and validates at runtime — the API
 * validates incoming requests with them, and the web client validates
 * responses with them.
 */

export const API_VERSION = 'v1' as const;

export * from './health';
export * from './auth';
export * from './organization';
export * from './location';
export * from './permission';
export * from './invitation';
export * from './module';
export * from './subscription';
