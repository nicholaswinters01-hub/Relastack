-- Phase 4: seed the system roles and permissions, migrate existing members
-- onto them, and apply row-level security to the new tenant-owned tables.

-- ---------------------------------------------------------------------------
-- 1. Permission catalogue.
-- ---------------------------------------------------------------------------
-- Keyed by string so a module can declare what it needs without a schema
-- change. Idempotent, so later phases append rather than rewrite.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('organization.read',   'core',      'View organization settings'),
  ('organization.write',  'core',      'Change organization settings'),
  ('member.read',         'core',      'View people in the organization'),
  ('member.invite',       'core',      'Invite people to the organization'),
  ('member.manage',       'core',      'Change or remove role assignments'),
  ('location.read',       'locations', 'View locations'),
  ('location.write',      'locations', 'Create and edit locations'),
  ('location.assign',     'locations', 'Assign people to locations')
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. System roles.
-- ---------------------------------------------------------------------------
-- organization_id NULL means "shared by every organization". Customer-defined
-- roles set it, and are gated behind a higher subscription tier from Phase 5.
--
-- Fixed UUIDs so later migrations, seeds and tests can reference them without
-- a lookup, and so running this migration on any environment produces
-- identical ids.

INSERT INTO "roles" ("id", "organization_id", "key", "name", "description", "default_scope", "is_system", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-a000-000000000001', NULL, 'org_admin',
   'Organization Administrator', 'Full control of the company and every location.',
   'ORGANIZATION', true, now(), now()),
  ('00000000-0000-4000-a000-000000000002', NULL, 'location_manager',
   'Location Manager', 'Manages the specific locations they are assigned to.',
   'LOCATION', true, now(), now()),
  ('00000000-0000-4000-a000-000000000003', NULL, 'employee',
   'Employee', 'Day-to-day access at the locations they are assigned to.',
   'LOCATION', true, now(), now())
ON CONFLICT ("id") DO NOTHING;

-- Organization Administrator: everything.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-000000000001', "key" FROM "permissions"
ON CONFLICT DO NOTHING;

-- Location Manager: runs their locations and the people at them, but cannot
-- change company-wide settings or create new locations. Creating a location
-- adds a billable unit, which is an owner decision rather than an operational
-- one.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000002', 'organization.read'),
  ('00000000-0000-4000-a000-000000000002', 'member.read'),
  ('00000000-0000-4000-a000-000000000002', 'member.invite'),
  ('00000000-0000-4000-a000-000000000002', 'location.read'),
  ('00000000-0000-4000-a000-000000000002', 'location.assign')
ON CONFLICT DO NOTHING;

-- Employee: read-only over the places they work.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000003', 'organization.read'),
  ('00000000-0000-4000-a000-000000000003', 'member.read'),
  ('00000000-0000-4000-a000-000000000003', 'location.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Migrate existing members onto the new model.
-- ---------------------------------------------------------------------------
-- Derived from the legacy organization_memberships.role column, which is NOT
-- dropped here: dropping a column in the same migration that reads it is how
-- data gets lost. A later migration removes it once nothing reads it.
--
-- OWNER  -> Organization Administrator, organization-wide.
-- MEMBER -> Employee, organization-wide.
--
-- Existing members become ORGANIZATION-scoped Employees rather than
-- LOCATION-scoped ones because they hold no location assignments yet.
-- Narrowing them silently would revoke access they currently have.

INSERT INTO "membership_roles" ("id", "membership_id", "role_id", "scope", "organization_id", "created_at")
SELECT
  gen_random_uuid(),
  m."id",
  CASE m."role"
    WHEN 'OWNER' THEN '00000000-0000-4000-a000-000000000001'::uuid
    ELSE '00000000-0000-4000-a000-000000000003'::uuid
  END,
  'ORGANIZATION',
  m."organization_id",
  now()
FROM "organization_memberships" m
ON CONFLICT ("membership_id", "role_id", "scope") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_role_isolation ON "membership_roles"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "membership_role_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_role_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_role_location_isolation ON "membership_role_locations"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_isolation ON "invitations"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "invitation_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_location_isolation ON "invitation_locations"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- roles: the policy admits shared system roles (organization_id IS NULL) as
-- well as the tenant's own. Without the NULL branch every organization would
-- be unable to read the roles it actually uses.
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY role_isolation ON "roles"
  USING (
    "organization_id" IS NULL
    OR "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  )
  -- Writes are narrower than reads: a customer may create roles only inside
  -- their own organization, never new shared system roles.
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  );

-- The denormalised organization_id on a scoped assignment must agree with the
-- location it points at. The policy alone would accept a row whose
-- organization_id matches the tenant while its location belongs elsewhere.
CREATE OR REPLACE FUNCTION assert_membership_role_location_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
BEGIN
  SELECT "organization_id" INTO location_org FROM "locations" WHERE "id" = NEW."location_id";

  IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      'membership_role_locations.organization_id (%) does not match the location organization (%)',
      NEW."organization_id", location_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER membership_role_location_tenant_check
  BEFORE INSERT OR UPDATE ON "membership_role_locations"
  FOR EACH ROW EXECUTE FUNCTION assert_membership_role_location_tenant();

-- Deliberately NOT protected by RLS:
--   permissions      -- a global catalogue, identical for every organization
--                       and containing no customer data.
--   role_permissions -- describes system roles, which are shared. It carries
--                       no organization_id to scope by, and revealing that
--                       "Employee can read locations" tells an attacker
--                       nothing the product documentation would not.
