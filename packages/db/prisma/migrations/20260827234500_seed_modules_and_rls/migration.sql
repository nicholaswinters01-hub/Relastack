-- Seed the module registry, enable core everywhere, and protect the
-- per-organization table with row-level security.

-- ---------------------------------------------------------------------------
-- 1. The registry.
-- ---------------------------------------------------------------------------
-- Mirrors MODULE_REGISTRY in @platform/shared, which remains the source of
-- truth. An e2e test asserts this table matches the registry, so drift fails
-- the build rather than surfacing as a module that cannot be stored.
--
-- ON CONFLICT DO UPDATE rather than DO NOTHING: re-running this migration on
-- an environment where a description changed should correct it.

INSERT INTO "modules" ("key", "name", "description", "is_core", "dependencies", "created_at", "updated_at") VALUES
  ('core', 'Core',
   'Accounts, organizations, locations, people and permissions. Always included.',
   true, ARRAY[]::text[], now(), now()),
  ('crm', 'CRM',
   'Leads, customers, contacts, notes and customer history.',
   false, ARRAY[]::text[], now(), now()),
  ('scheduling', 'Scheduling',
   'Appointments, availability and calendars.',
   false, ARRAY['crm']::text[], now(), now()),
  ('inventory', 'Inventory',
   'Stock, items and levels per location.',
   false, ARRAY[]::text[], now(), now()),
  ('reporting', 'Reporting',
   'Dashboards and operational reports.',
   false, ARRAY[]::text[], now(), now()),
  ('automation', 'Automation',
   'Trigger, condition and action workflows.',
   false, ARRAY['crm']::text[], now(), now()),
  ('custom_roles', 'Custom Roles',
   'Define your own roles and permission sets, beyond the built-in ones.',
   false, ARRAY[]::text[], now(), now())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "is_core" = EXCLUDED."is_core",
  "dependencies" = EXCLUDED."dependencies",
  "updated_at" = now();

-- ---------------------------------------------------------------------------
-- 2. Enable core for every existing organization.
-- ---------------------------------------------------------------------------
-- Core carries the account itself — signing in, locations, people. An
-- organization without it would be locked out of its own data.
--
-- Deliberately ONLY core. A row's absence means "not enabled", so every other
-- module stays off until someone chooses it. The alternative — enabling
-- everything for existing customers — would hand away paid capabilities on
-- the day they ship.

INSERT INTO "organization_modules" ("organization_id", "module_key", "enabled", "enabled_at", "created_at", "updated_at")
SELECT o."id", 'core', true, now(), now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id", "module_key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_modules" FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_module_isolation ON "organization_modules"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Deliberately NOT protected by RLS: "modules".
--
-- It is a global catalogue identical for every organization, containing no
-- customer data. Which modules the product offers is public information — it
-- is on the pricing page. What is tenant-specific is which ones a given
-- organization has, and that lives in organization_modules above.

-- ---------------------------------------------------------------------------
-- 4. Core cannot be disabled.
-- ---------------------------------------------------------------------------
-- The service refuses this too, but a database constraint is what makes it
-- true regardless of which code path attempts it — including a future
-- migration, an admin script, or a bug.

CREATE OR REPLACE FUNCTION assert_core_module_stays_enabled()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."module_key" = 'core' AND NEW."enabled" = false THEN
    RAISE EXCEPTION 'The core module cannot be disabled';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_module_core_check
  BEFORE INSERT OR UPDATE ON "organization_modules"
  FOR EACH ROW EXECUTE FUNCTION assert_core_module_stays_enabled();
