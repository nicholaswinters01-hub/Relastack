-- Validate a task reference only when it actually changes.
--
-- The original trigger re-checked all four references on every UPDATE, which
-- breaks during a cascade.
--
-- A task points at a membership twice: assignee and creator. Deleting a user
-- cascades to their membership, which fires SET NULL on BOTH columns -- as two
-- separate updates. While the first is being nulled the second still holds the
-- id of a membership that has already gone, so the lookup finds nothing and
-- the trigger refuses a delete that was perfectly legitimate.
--
-- The consequence was not subtle: removing anyone who had ever been assigned a
-- task, or had ever created one, failed outright.
--
-- Checking only what changed is both correct and cheaper -- an ordinary status
-- update no longer does four pointless lookups. CREATE OR REPLACE rather than
-- editing the applied migration, which would break its checksum.

CREATE OR REPLACE FUNCTION assert_task_references_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  IF NEW."location_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."location_id" IS DISTINCT FROM OLD."location_id") THEN
    SELECT "organization_id" INTO other_org FROM "locations" WHERE "id" = NEW."location_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.location_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."customer_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id") THEN
    SELECT "organization_id" INTO other_org FROM "customers" WHERE "id" = NEW."customer_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.customer_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."assignee_membership_id" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW."assignee_membership_id" IS DISTINCT FROM OLD."assignee_membership_id") THEN
    SELECT "organization_id" INTO other_org FROM "organization_memberships"
      WHERE "id" = NEW."assignee_membership_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.assignee_membership_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."created_by_membership_id" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW."created_by_membership_id" IS DISTINCT FROM OLD."created_by_membership_id") THEN
    SELECT "organization_id" INTO other_org FROM "organization_memberships"
      WHERE "id" = NEW."created_by_membership_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.created_by_membership_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
