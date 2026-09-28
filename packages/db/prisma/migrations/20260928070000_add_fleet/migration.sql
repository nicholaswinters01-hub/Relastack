-- Fleet: vehicles and equipment, readings, reminders, service; vehicles as stock places;
-- a vehicle on a job; the Pest Control pack shell that brings Fleet and Inventory.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateEnum
CREATE TYPE "fleet_asset_kind" AS ENUM ('VEHICLE', 'TRAILER', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "fleet_asset_status" AS ENUM ('ACTIVE', 'IN_SHOP', 'RETIRED');

-- CreateEnum
CREATE TYPE "fleet_meter" AS ENUM ('MILES', 'HOURS', 'NONE');

-- AlterEnum
ALTER TYPE "stock_place_kind" ADD VALUE 'VEHICLE';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "vehicle_id" UUID;

-- AlterTable
ALTER TABLE "stock_places" ADD COLUMN     "fleet_asset_id" UUID;

-- CreateTable
CREATE TABLE "fleet_assets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "fleet_asset_kind" NOT NULL,
    "status" "fleet_asset_status" NOT NULL DEFAULT 'ACTIVE',
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "plate" TEXT,
    "identifier" TEXT,
    "meter" "fleet_meter" NOT NULL DEFAULT 'MILES',
    "notes" TEXT,
    "assigned_membership_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_readings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "value" DECIMAL(10,1) NOT NULL,
    "read_on" DATE NOT NULL,
    "recorded_by_id" UUID,
    "recorded_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_reminders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "interval_months" INTEGER,
    "interval_reading" DECIMAL(10,1),
    "next_due_on" DATE,
    "next_due_reading" DECIMAL(10,1),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_service_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "reminder_id" UUID,
    "title" TEXT NOT NULL,
    "done_on" DATE NOT NULL,
    "reading" DECIMAL(10,1),
    "cost_cents" INTEGER,
    "note" TEXT,
    "recorded_by_id" UUID,
    "recorded_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_service_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_assets_organization_id_idx" ON "fleet_assets"("organization_id");

-- CreateIndex
CREATE INDEX "fleet_assets_location_id_idx" ON "fleet_assets"("location_id");

-- CreateIndex
CREATE INDEX "fleet_readings_organization_id_idx" ON "fleet_readings"("organization_id");

-- CreateIndex
CREATE INDEX "fleet_readings_asset_id_read_on_idx" ON "fleet_readings"("asset_id", "read_on");

-- CreateIndex
CREATE INDEX "fleet_reminders_organization_id_idx" ON "fleet_reminders"("organization_id");

-- CreateIndex
CREATE INDEX "fleet_reminders_asset_id_idx" ON "fleet_reminders"("asset_id");

-- CreateIndex
CREATE INDEX "fleet_service_records_organization_id_idx" ON "fleet_service_records"("organization_id");

-- CreateIndex
CREATE INDEX "fleet_service_records_asset_id_done_on_idx" ON "fleet_service_records"("asset_id", "done_on");

-- CreateIndex
CREATE INDEX "jobs_vehicle_id_idx" ON "jobs"("vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_places_fleet_asset_id_key" ON "stock_places"("fleet_asset_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_places" ADD CONSTRAINT "stock_places_fleet_asset_id_fkey" FOREIGN KEY ("fleet_asset_id") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_assets" ADD CONSTRAINT "fleet_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_assets" ADD CONSTRAINT "fleet_assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_assets" ADD CONSTRAINT "fleet_assets_assigned_membership_id_fkey" FOREIGN KEY ("assigned_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_readings" ADD CONSTRAINT "fleet_readings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_readings" ADD CONSTRAINT "fleet_readings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_readings" ADD CONSTRAINT "fleet_readings_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_reminders" ADD CONSTRAINT "fleet_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_reminders" ADD CONSTRAINT "fleet_reminders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_service_records" ADD CONSTRAINT "fleet_service_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_service_records" ADD CONSTRAINT "fleet_service_records_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_service_records" ADD CONSTRAINT "fleet_service_records_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "fleet_reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_service_records" ADD CONSTRAINT "fleet_service_records_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
--
-- The new 'VEHICLE' place kind cannot be used until this transaction commits,
-- so nothing here names it: constraints are written in terms of 'BRANCH'.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Modules: Fleet comes with a pack; the Pest Control pack brings it.
-- ---------------------------------------------------------------------------

INSERT INTO "modules" ("key", "name", "description", "is_core", "dependencies", "created_at", "updated_at") VALUES
  ('fleet', 'Fleet',
   'Vehicles and equipment, readings, service reminders, and the stock each van carries.',
   false, ARRAY[]::text[], now(), now()),
  ('pest_control', 'Pest Control',
   'Pest control on top of the core: application records on every job, with vans and product stock included.',
   false, ARRAY['scheduling', 'inventory', 'fleet']::text[], now(), now())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "dependencies" = EXCLUDED."dependencies",
  "updated_at" = now();

-- The trial includes everything, so that evaluation is not hobbled by
-- packaging. Paying plans get the pack by hand from staff until choosing a
-- pack is built.
INSERT INTO "plan_modules" ("plan_key", "module_key") VALUES
  ('trial', 'fleet'),
  ('trial', 'pest_control')
ON CONFLICT DO NOTHING;

-- Staff grant a pack as an add-on. Account information, like the rest of the
-- subscription; reading and removing were already allowed.
CREATE POLICY subscription_add_ons_staff_insert ON "subscription_add_ons" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- ---------------------------------------------------------------------------
-- Assets.
-- ---------------------------------------------------------------------------

-- One name per business among assets still in service, whatever the capitals.
CREATE UNIQUE INDEX "fleet_assets_organization_name_key"
  ON "fleet_assets" ("organization_id", lower("name")) WHERE "status" <> 'RETIRED';

ALTER TABLE "fleet_assets"
  ADD CONSTRAINT "fleet_assets_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  ADD CONSTRAINT "fleet_assets_year_range" CHECK ("year" IS NULL OR "year" BETWEEN 1950 AND 2100);

-- The branch and the usual driver must belong to the asset's business.
-- Checked only when they change, so the driver leaving (which nulls the
-- column) is never re-validated against a row that is going.
CREATE OR REPLACE FUNCTION assert_fleet_asset_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
  member_org uuid;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."location_id" IS DISTINCT FROM OLD."location_id" THEN
    SELECT "organization_id" INTO location_org FROM "locations" WHERE "id" = NEW."location_id";
    IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'fleet_assets: location % and row % are not one organization',
        location_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."assigned_membership_id" IS NOT NULL AND (TG_OP = 'INSERT'
     OR NEW."assigned_membership_id" IS DISTINCT FROM OLD."assigned_membership_id") THEN
    SELECT "organization_id" INTO member_org FROM "organization_memberships"
      WHERE "id" = NEW."assigned_membership_id";
    IF member_org IS NULL OR member_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'fleet_assets: driver % and row % are not one organization',
        member_org, NEW."organization_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fleet_asset_tenant_check
  BEFORE INSERT OR UPDATE ON "fleet_assets"
  FOR EACH ROW EXECUTE FUNCTION assert_fleet_asset_tenant();

-- Readings, reminders and service records belong to their asset's business,
-- and a service record's reminder to the same asset.
CREATE OR REPLACE FUNCTION assert_fleet_child_tenant()
RETURNS TRIGGER AS $$
DECLARE
  asset_org uuid;
BEGIN
  SELECT "organization_id" INTO asset_org FROM "fleet_assets" WHERE "id" = NEW."asset_id";
  IF asset_org IS NULL OR asset_org <> NEW."organization_id" THEN
    RAISE EXCEPTION '%: asset % and row % are not one organization',
      TG_TABLE_NAME, asset_org, NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fleet_reading_tenant_check
  BEFORE INSERT ON "fleet_readings"
  FOR EACH ROW EXECUTE FUNCTION assert_fleet_child_tenant();
CREATE TRIGGER fleet_reminder_tenant_check
  BEFORE INSERT ON "fleet_reminders"
  FOR EACH ROW EXECUTE FUNCTION assert_fleet_child_tenant();

CREATE OR REPLACE FUNCTION assert_fleet_service_tenant()
RETURNS TRIGGER AS $$
DECLARE
  asset_org uuid;
  reminder_asset uuid;
BEGIN
  SELECT "organization_id" INTO asset_org FROM "fleet_assets" WHERE "id" = NEW."asset_id";
  IF asset_org IS NULL OR asset_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'fleet_service_records: asset % and row % are not one organization',
      asset_org, NEW."organization_id";
  END IF;

  IF NEW."reminder_id" IS NOT NULL THEN
    SELECT "asset_id" INTO reminder_asset FROM "fleet_reminders" WHERE "id" = NEW."reminder_id";
    IF reminder_asset IS NULL OR reminder_asset <> NEW."asset_id" THEN
      RAISE EXCEPTION 'fleet_service_records: reminder % is not for asset %',
        NEW."reminder_id", NEW."asset_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fleet_service_tenant_check
  BEFORE INSERT ON "fleet_service_records"
  FOR EACH ROW EXECUTE FUNCTION assert_fleet_service_tenant();

ALTER TABLE "fleet_readings"
  ADD CONSTRAINT "fleet_readings_positive" CHECK ("value" >= 0);

ALTER TABLE "fleet_reminders"
  ADD CONSTRAINT "fleet_reminders_something_due" CHECK (
    "interval_months" IS NOT NULL OR "interval_reading" IS NOT NULL
    OR "next_due_on" IS NOT NULL OR "next_due_reading" IS NOT NULL
  ),
  ADD CONSTRAINT "fleet_reminders_intervals_positive" CHECK (
    ("interval_months" IS NULL OR "interval_months" > 0)
    AND ("interval_reading" IS NULL OR "interval_reading" > 0)
  );

ALTER TABLE "fleet_service_records"
  ADD CONSTRAINT "fleet_service_records_cost_positive" CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0);

-- ---------------------------------------------------------------------------
-- A vehicle is a stock place too.
-- ---------------------------------------------------------------------------

-- A branch place names no asset; any other place names exactly one.
ALTER TABLE "stock_places"
  ADD CONSTRAINT "stock_places_kind_asset" CHECK (("kind" = 'BRANCH') = ("fleet_asset_id" IS NULL));

-- Extend the place check to the asset. Replacing the function keeps both
-- existing triggers pointing at it.
CREATE OR REPLACE FUNCTION assert_stock_place_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
  asset_org uuid;
BEGIN
  SELECT "organization_id" INTO location_org FROM "locations" WHERE "id" = NEW."location_id";

  IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'stock_places: location % and row % are not one organization',
      location_org, NEW."organization_id";
  END IF;

  IF NEW."fleet_asset_id" IS NOT NULL THEN
    SELECT "organization_id" INTO asset_org FROM "fleet_assets" WHERE "id" = NEW."fleet_asset_id";
    IF asset_org IS NULL OR asset_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'stock_places: asset % and row % are not one organization',
        asset_org, NEW."organization_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A vehicle on a job must be the job's business's vehicle.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_job_vehicle_tenant()
RETURNS TRIGGER AS $$
DECLARE
  asset_org uuid;
BEGIN
  SELECT "organization_id" INTO asset_org FROM "fleet_assets" WHERE "id" = NEW."vehicle_id";
  IF asset_org IS NULL OR asset_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'jobs: vehicle % and job % are not one organization',
      asset_org, NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only when a vehicle is set or changed: clearing it, or the vehicle being
-- removed (which nulls the column), needs no check.
CREATE TRIGGER job_vehicle_tenant_check
  BEFORE INSERT ON "jobs"
  FOR EACH ROW WHEN (NEW."vehicle_id" IS NOT NULL)
  EXECUTE FUNCTION assert_job_vehicle_tenant();
CREATE TRIGGER job_vehicle_tenant_recheck
  BEFORE UPDATE OF "vehicle_id" ON "jobs"
  FOR EACH ROW WHEN (NEW."vehicle_id" IS NOT NULL AND NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id")
  EXECUTE FUNCTION assert_job_vehicle_tenant();

-- ---------------------------------------------------------------------------
-- Row-level security. No staff policies: vehicles and their service are what
-- a business keeps, not account information.
-- ---------------------------------------------------------------------------

ALTER TABLE "fleet_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_asset_isolation ON "fleet_assets"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "fleet_readings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_readings" FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_reading_isolation ON "fleet_readings"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "fleet_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_reminder_isolation ON "fleet_reminders"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "fleet_service_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_service_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_service_record_isolation ON "fleet_service_records"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Readings are append-only: the latest is current, and a wrong one is
-- followed by a right one rather than rewritten.
REVOKE UPDATE, DELETE, TRUNCATE ON "fleet_readings" FROM platform_app;

-- ---------------------------------------------------------------------------
-- Permissions.
-- ---------------------------------------------------------------------------

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('fleet.read',  'fleet', 'See vehicles, equipment and their service'),
  ('fleet.write', 'fleet', 'Add and edit vehicles, log readings and service')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000001', 'fleet.read'),
  ('00000000-0000-4000-a000-000000000001', 'fleet.write'),
  ('00000000-0000-4000-a000-000000000002', 'fleet.read'),
  ('00000000-0000-4000-a000-000000000002', 'fleet.write'),
  -- Employees see the fleet; the usual driver logs readings on their own
  -- vehicle whatever their role.
  ('00000000-0000-4000-a000-000000000003', 'fleet.read')
ON CONFLICT DO NOTHING;
