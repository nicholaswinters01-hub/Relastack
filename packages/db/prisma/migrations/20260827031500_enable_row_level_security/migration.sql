-- Row-Level Security: the layer that holds when application code is wrong.
--
-- Application-level filtering fails in one specific, extremely common way:
-- someone writes a query and forgets the tenant predicate. Code review catches
-- most of those. "Most" is not an acceptable standard for tenant isolation.
--
-- Everything below exists so that a missing WHERE clause returns zero rows
-- instead of another company's data.

-- ---------------------------------------------------------------------------
-- 1. A dedicated application role.
-- ---------------------------------------------------------------------------
--
-- THIS IS THE STEP THAT MAKES RLS REAL. PostgreSQL exempts superusers from
-- row-level security unconditionally, and exempts table owners unless the
-- table is set to FORCE. The migration role (`platform`) is a superuser and
-- owns every table, so an application connecting as it would bypass every
-- policy below while appearing perfectly configured.
--
-- `platform_app` is neither superuser nor table owner and has no BYPASSRLS.
--
-- Created idempotently so this migration works against a fresh local volume,
-- a CI service container, and a production database where the role was
-- provisioned out-of-band with a real secret. The literal password here is a
-- development default and is only ever used when the role does not exist yet;
-- production must create the role BEFORE migrating so this block is skipped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN PASSWORD 'platform_app_dev_password';
  END IF;
END
$$;

-- Refuse to continue if the role has either attribute that would silently
-- defeat RLS. Checked rather than stripped: `ALTER ROLE ... NOSUPERUSER` needs
-- a real superuser, and no hosted Postgres (Neon, RDS, Render) grants one, so
-- stripping made this migration impossible to apply anywhere but locally.
-- Changed after being applied, with the product owner's approval
-- (2026-09-26), before it had ever run against a shared database.
--
-- Membership counts too: a member of a role with either attribute can
-- `SET ROLE` into it. That is exactly what a role created through Neon's
-- console is — a member of neon_superuser, which has BYPASSRLS.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles r
    WHERE (r.rolsuper OR r.rolbypassrls)
      AND pg_has_role('platform_app', r.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'platform_app has, or can assume, SUPERUSER or BYPASSRLS, so row-level security would enforce nothing. Recreate it with a plain CREATE ROLE.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Privileges.
-- ---------------------------------------------------------------------------
-- Data access only. No DDL: the application must never be able to alter or
-- drop a table, which also means it can never disable a policy.

GRANT USAGE ON SCHEMA public TO platform_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app;

-- Future tables inherit the same grants, so adding a table in a later phase
-- does not silently become unreadable by the application.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_app;

-- ---------------------------------------------------------------------------
-- 3. Policies.
-- ---------------------------------------------------------------------------
--
-- `current_setting(name, true)` returns NULL when the setting is absent rather
-- than raising. NULLIF(...,'') then turns an empty string into NULL as well,
-- because an empty string would fail the ::uuid cast.
--
-- Both cases produce NULL, and `column = NULL` is NULL, which is not TRUE — so
-- a query with no tenant context set matches NOTHING. Failing closed is the
-- entire point: forgetting to establish context must deny access, never grant
-- it.

-- --- organizations ---------------------------------------------------------

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_isolation ON "organizations"
  USING ("id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- --- organization_memberships ----------------------------------------------

ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;

-- Two readable cases, and they are an authorization rule rather than an escape
-- hatch:
--
--   1. Rows belonging to the organization currently in context — how an
--      organization lists its own members.
--   2. Rows that are the caller's OWN membership — how a just-authenticated
--      user discovers which organization they belong to, before any
--      organization context can possibly exist.
--
-- Case 2 is what removes the need for a "skip RLS" flag. A bypass flag would
-- work today and become the thing that leaks data in year three.
CREATE POLICY membership_isolation ON "organization_memberships"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  -- Writes are narrower than reads: a row may only ever be written into the
  -- organization currently in context. Without this, a caller could insert
  -- themselves into someone else's organization.
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- Deliberately NOT protected by RLS: "users" and "sessions".
-- ---------------------------------------------------------------------------
-- Both are global identity, not tenant-owned. Authentication must resolve a
-- user and their session BEFORE any organization is known, so policies keyed
-- on organization would make login impossible. Access to them is guarded by
-- the session token itself.
