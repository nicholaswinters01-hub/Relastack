-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "detached_from_series" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "series_id" UUID,
ADD COLUMN     "series_occurrence_on" DATE;

-- CreateTable
CREATE TABLE "job_series" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location_id" UUID,
    "customer_id" UUID,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "by_weekday" INTEGER[],
    "starts_on" DATE NOT NULL,
    "start_minutes" INTEGER NOT NULL,
    "until" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_series_assignments" (
    "series_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "job_series_assignments_pkey" PRIMARY KEY ("series_id","membership_id")
);

-- CreateIndex
CREATE INDEX "job_series_organization_id_active_idx" ON "job_series"("organization_id", "active");

-- CreateIndex
CREATE INDEX "job_series_customer_id_idx" ON "job_series"("customer_id");

-- CreateIndex
CREATE INDEX "job_series_assignments_organization_id_idx" ON "job_series_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "jobs_series_id_series_occurrence_on_idx" ON "jobs"("series_id", "series_occurrence_on");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "job_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_created_by_membership_id_fkey" FOREIGN KEY ("created_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series_assignments" ADD CONSTRAINT "job_series_assignments_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "job_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_series_assignments" ADD CONSTRAINT "job_series_assignments_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "job_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_series" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_series_isolation ON "job_series"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "job_series_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_series_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_series_assignment_isolation ON "job_series_assignments"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Sanity constraints on the rule itself.
-- ---------------------------------------------------------------------------
-- A zero or negative interval loops forever when generating occurrences, and
-- a zero-length visit is not a booking. Both are refused at the boundary too;
-- these stand whatever calls the database.

ALTER TABLE "job_series" ADD CONSTRAINT "job_series_interval_positive" CHECK ("interval" > 0);
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_duration_positive" CHECK ("duration_minutes" > 0);
ALTER TABLE "job_series" ADD CONSTRAINT "job_series_start_minutes_in_day"
  CHECK ("start_minutes" >= 0 AND "start_minutes" < 1440);

-- ---------------------------------------------------------------------------
-- Tenant checks, changed columns only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_series_references_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  IF NEW."location_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."location_id" IS DISTINCT FROM OLD."location_id") THEN
    SELECT "organization_id" INTO other_org FROM "locations" WHERE "id" = NEW."location_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'job_series.location_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."customer_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id") THEN
    SELECT "organization_id" INTO other_org FROM "customers" WHERE "id" = NEW."customer_id";
    IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'job_series.customer_id belongs to organization (%), not (%)',
        other_org, NEW."organization_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_series_tenant_check
  BEFORE INSERT OR UPDATE ON "job_series"
  FOR EACH ROW EXECUTE FUNCTION assert_series_references_tenant();

CREATE OR REPLACE FUNCTION assert_series_assignment_tenant()
RETURNS TRIGGER AS $$
DECLARE
  other_org uuid;
BEGIN
  SELECT "organization_id" INTO other_org FROM "job_series" WHERE "id" = NEW."series_id";
  IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_series_assignments.series_id belongs to organization (%), not (%)',
      other_org, NEW."organization_id";
  END IF;

  SELECT "organization_id" INTO other_org FROM "organization_memberships"
    WHERE "id" = NEW."membership_id";
  IF other_org IS NULL OR other_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_series_assignments.membership_id belongs to organization (%), not (%)',
      other_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_series_assignment_tenant_check
  BEFORE INSERT OR UPDATE ON "job_series_assignments"
  FOR EACH ROW EXECUTE FUNCTION assert_series_assignment_tenant();

-- ---------------------------------------------------------------------------
-- One job per occurrence.
-- ---------------------------------------------------------------------------
-- Regeneration finds what already exists by (series, day). Without this, a
-- concurrent top-up could double-book the same visit -- and a duplicated
-- recurring job is the failure customers notice fastest.

CREATE UNIQUE INDEX jobs_one_per_occurrence
  ON "jobs" ("series_id", "series_occurrence_on")
  WHERE "series_id" IS NOT NULL;
