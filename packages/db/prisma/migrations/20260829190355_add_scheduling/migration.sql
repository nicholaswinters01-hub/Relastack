-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "job_id" UUID;

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "job_status" NOT NULL DEFAULT 'SCHEDULED',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "location_id" UUID,
    "customer_id" UUID,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_assignments" (
    "job_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_assignments_pkey" PRIMARY KEY ("job_id","membership_id")
);

-- CreateIndex
CREATE INDEX "jobs_organization_id_starts_at_idx" ON "jobs"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "jobs_organization_id_status_idx" ON "jobs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "jobs_organization_id_location_id_idx" ON "jobs"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "jobs_customer_id_idx" ON "jobs"("customer_id");

-- CreateIndex
CREATE INDEX "job_assignments_organization_id_idx" ON "job_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "job_assignments_membership_id_idx" ON "job_assignments"("membership_id");

-- CreateIndex
CREATE INDEX "tasks_job_id_idx" ON "tasks"("job_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_membership_id_fkey" FOREIGN KEY ("created_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A job cannot end before it starts.
-- ---------------------------------------------------------------------------
-- Enforced here rather than only in the service. A negative-length appointment
-- silently corrupts every calendar render and every conflict query that reads
-- it afterwards, and those are exactly the places nobody looks first.

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_end_after_start" CHECK ("ends_at" > "starts_at");

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_isolation ON "jobs"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "job_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_assignment_isolation ON "job_assignments"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Everything a job points at must belong to the same organization.
-- ---------------------------------------------------------------------------
-- Only what CHANGED is validated. A job references a membership, and deleting
-- a person nulls that column while other columns may transiently still point
-- at rows already gone -- the cascade problem Phase 8 hit on tasks.

CREATE OR REPLACE FUNCTION assert_job_references_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  IF NEW."location_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."location_id" IS DISTINCT FROM OLD."location_id") THEN
    SELECT "organization_id" INTO other_org FROM "locations" WHERE "id" = NEW."location_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'jobs.location_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."customer_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id") THEN
    SELECT "organization_id" INTO other_org FROM "customers" WHERE "id" = NEW."customer_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'jobs.customer_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."created_by_membership_id" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW."created_by_membership_id" IS DISTINCT FROM OLD."created_by_membership_id") THEN
    SELECT "organization_id" INTO other_org FROM "organization_memberships"
      WHERE "id" = NEW."created_by_membership_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'jobs.created_by_membership_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_tenant_check
  BEFORE INSERT OR UPDATE ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION assert_job_references_tenant();

-- An assignment must match both the job and the person it names.
CREATE OR REPLACE FUNCTION assert_job_assignment_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  SELECT "organization_id" INTO other_org FROM "jobs" WHERE "id" = NEW."job_id";
  IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_assignments.job_id belongs to organization (%), not (%)',
      other_org, NEW."organization_id";
  END IF;

  SELECT "organization_id" INTO other_org FROM "organization_memberships"
    WHERE "id" = NEW."membership_id";
  IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_assignments.membership_id belongs to organization (%), not (%)',
      other_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_assignment_tenant_check
  BEFORE INSERT OR UPDATE ON "job_assignments"
  FOR EACH ROW EXECUTE FUNCTION assert_job_assignment_tenant();

-- ---------------------------------------------------------------------------
-- The conflict query.
-- ---------------------------------------------------------------------------
-- "Is this person booked in an overlapping window" runs on every save, so it
-- gets an index rather than a scan. Partial: a cancelled job cannot conflict
-- with anything, and cancellations accumulate forever.

CREATE INDEX jobs_live_window
  ON "jobs" ("organization_id", "starts_at", "ends_at")
  WHERE "status" NOT IN ('CANCELLED');
