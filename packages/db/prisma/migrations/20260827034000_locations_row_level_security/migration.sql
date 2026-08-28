-- Row-level security for locations.
--
-- Same treatment as organizations and memberships in
-- 20260827031500_enable_row_level_security. Locations are the first entity
-- that is OWNED BY a tenant rather than BEING one, so this migration is the
-- template every business module follows from Phase 7 onward:
--
--   1. ENABLE + FORCE row level security
--   2. A policy comparing organization_id to the transaction's tenant context
--   3. A WITH CHECK clause so rows cannot be written into another tenant
--
-- The default grants added by the earlier migration
-- (ALTER DEFAULT PRIVILEGES ... GRANT ... TO platform_app) already cover these
-- new tables, so no explicit GRANT is needed here. That was the point of
-- setting them.

-- --- locations -------------------------------------------------------------

ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

CREATE POLICY location_isolation ON "locations"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  );

-- --- location_memberships --------------------------------------------------

ALTER TABLE "location_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_memberships" FORCE ROW LEVEL SECURITY;

-- Note the absence of the "or it is your own row" clause that
-- organization_memberships needs. That clause exists there solely so a
-- just-authenticated user can discover which organization they belong to,
-- before any organization context can exist. By the time location membership
-- is read, the organization is already known — so the narrower rule applies
-- and nothing is readable outside the current tenant.
CREATE POLICY location_membership_isolation ON "location_memberships"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  );

-- The denormalised organization_id must agree with the location it points at.
-- Without this, application code could write a row whose organization_id
-- satisfies the policy while its location belongs to a different tenant —
-- the policy would pass and the data would still be wrong.
CREATE OR REPLACE FUNCTION assert_location_membership_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
BEGIN
  SELECT "organization_id" INTO location_org FROM "locations" WHERE "id" = NEW."location_id";

  IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      'location_memberships.organization_id (%) does not match the location''s organization (%)',
      NEW."organization_id", location_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER location_membership_tenant_check
  BEFORE INSERT OR UPDATE ON "location_memberships"
  FOR EACH ROW EXECUTE FUNCTION assert_location_membership_tenant();
