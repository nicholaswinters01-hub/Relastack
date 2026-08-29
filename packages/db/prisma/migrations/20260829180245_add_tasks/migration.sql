-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "task_status" NOT NULL DEFAULT 'TODO',
    "priority" "task_priority" NOT NULL DEFAULT 'NORMAL',
    "due_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "location_id" UUID,
    "assignee_membership_id" UUID,
    "created_by_membership_id" UUID,
    "customer_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_organization_id_status_idx" ON "tasks"("organization_id", "status");

-- CreateIndex
CREATE INDEX "tasks_organization_id_assignee_membership_id_idx" ON "tasks"("organization_id", "assignee_membership_id");

-- CreateIndex
CREATE INDEX "tasks_organization_id_due_at_idx" ON "tasks"("organization_id", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_location_id_idx" ON "tasks"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "tasks_customer_id_idx" ON "tasks"("customer_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_membership_id_fkey" FOREIGN KEY ("assignee_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_membership_id_fkey" FOREIGN KEY ("created_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_isolation ON "tasks"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Everything a task points at must belong to the same organization.
-- ---------------------------------------------------------------------------
-- A task carries four references out. RLS keys on organization_id alone, so
-- without these a row could satisfy the policy while pointing at another
-- tenant's customer, location or member. Phase 6 hit exactly this shape on
-- subscription add-ons and Phase 7 on customer children.

CREATE OR REPLACE FUNCTION assert_task_references_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  IF NEW."location_id" IS NOT NULL THEN
    SELECT "organization_id" INTO other_org FROM "locations" WHERE "id" = NEW."location_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.location_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."customer_id" IS NOT NULL THEN
    SELECT "organization_id" INTO other_org FROM "customers" WHERE "id" = NEW."customer_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.customer_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."assignee_membership_id" IS NOT NULL THEN
    SELECT "organization_id" INTO other_org FROM "organization_memberships"
      WHERE "id" = NEW."assignee_membership_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'tasks.assignee_membership_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."created_by_membership_id" IS NOT NULL THEN
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

CREATE TRIGGER task_tenant_check
  BEFORE INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION assert_task_references_tenant();

-- ---------------------------------------------------------------------------
-- Finding overdue work.
-- ---------------------------------------------------------------------------
-- Partial: only open tasks can be overdue, and the open ones are a small and
-- shrinking fraction of the table over a business's lifetime.

CREATE INDEX tasks_open_due
  ON "tasks" ("organization_id", "due_at")
  WHERE "status" NOT IN ('DONE', 'CANCELLED');
