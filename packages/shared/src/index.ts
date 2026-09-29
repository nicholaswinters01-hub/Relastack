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
export * from './billing';
export * from './customer';
export * from './customer-import';
export * from './task';
export * from './job';
export * from './recurrence';
export * from './job-series';
export * from './report';
export * from './notification';
export * from './staff';
export * from './support';
export * from './search';
export * from './group';
export * from './inventory';
export * from './fleet';
export * from './pack-fields';
export * from './pest-records';
export * from './board';
export * from './integrations';
export * from './contracts';
export * from './performance';
