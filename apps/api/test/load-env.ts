import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Loads the repository's .env before any test file is imported.
 *
 * Each suite also calls loadDotenv at its top, but ES module imports are
 * hoisted above it, and the application reads its configuration while being
 * imported. Without this, the suites pass only in a shell that already has the
 * variables set, and fail everywhere else.
 */
loadDotenv({ path: resolve(__dirname, '../../../.env') });
