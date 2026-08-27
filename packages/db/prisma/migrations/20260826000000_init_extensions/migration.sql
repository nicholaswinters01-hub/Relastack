-- Initial migration: PostgreSQL extensions.
--
-- No domain tables are created in Phase 0. This migration establishes the
-- migration pipeline itself and enables the extensions the platform relies on
-- from Phase 1 onward.
--
-- citext  — case-insensitive text. Used for email addresses so that
--           "Nick@example.com" and "nick@example.com" cannot become two
--           distinct user accounts.
-- pgcrypto — cryptographic helpers, including gen_random_uuid() on older
--           PostgreSQL versions and digest() for token hashing in SQL.

CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
