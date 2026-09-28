-- Stock used on jobs, pack fields on items, people and movements, voids, and
-- customer sign-offs. The pest application record is built from these.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)


-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "pack_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "organization_memberships" ADD COLUMN     "pack_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "job_id" UUID,
ADD COLUMN     "pack_fields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "voids_movement_id" UUID;

-- CreateTable
CREATE TABLE "job_signoffs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "signer_name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_id" UUID,
    "recorded_by_name" TEXT NOT NULL,

    CONSTRAINT "job_signoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_signoffs_organization_id_idx" ON "job_signoffs"("organization_id");

-- CreateIndex
CREATE INDEX "job_signoffs_job_id_idx" ON "job_signoffs"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_voids_movement_id_key" ON "stock_movements"("voids_movement_id");

-- CreateIndex
CREATE INDEX "stock_movements_job_id_idx" ON "stock_movements"("job_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_voids_movement_id_fkey" FOREIGN KEY ("voids_movement_id") REFERENCES "stock_movements"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- Stock used on a job is a "used" row, or the correction that voids one.
-- A void corrects exactly one row and says so.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_job_use" CHECK (
    "job_id" IS NULL OR "reason" IN ('USED', 'CORRECTED')
  ),
  ADD CONSTRAINT "stock_movements_void_is_correction" CHECK (
    "voids_movement_id" IS NULL OR "reason" = 'CORRECTED'
  );

-- Extend the movement check to the job and to the row being voided: all one
-- business, and a void puts back the same item at the same place.
CREATE OR REPLACE FUNCTION assert_stock_movement_tenant()
RETURNS TRIGGER AS $$
DECLARE
  item_org uuid;
  place_org uuid;
  job_org uuid;
  voided record;
BEGIN
  SELECT "organization_id" INTO item_org FROM "inventory_items" WHERE "id" = NEW."item_id";
  SELECT "organization_id" INTO place_org FROM "stock_places" WHERE "id" = NEW."place_id";

  IF item_org IS NULL OR place_org IS NULL
     OR item_org <> NEW."organization_id" OR place_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'stock_movements: item %, place % and row % are not one organization',
      item_org, place_org, NEW."organization_id";
  END IF;

  IF NEW."job_id" IS NOT NULL THEN
    SELECT "organization_id" INTO job_org FROM "jobs" WHERE "id" = NEW."job_id";
    IF job_org IS NULL OR job_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'stock_movements: job % and row % are not one organization',
        job_org, NEW."organization_id";
    END IF;
  END IF;

  IF NEW."voids_movement_id" IS NOT NULL THEN
    SELECT "organization_id", "item_id", "place_id", "job_id" INTO voided
      FROM "stock_movements" WHERE "id" = NEW."voids_movement_id";
    IF voided IS NULL OR voided."organization_id" <> NEW."organization_id"
       OR voided."item_id" <> NEW."item_id" OR voided."place_id" <> NEW."place_id"
       OR voided."job_id" IS DISTINCT FROM NEW."job_id" THEN
      RAISE EXCEPTION 'stock_movements: a void must put back the same item at the same place';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Sign-offs.
-- ---------------------------------------------------------------------------

ALTER TABLE "job_signoffs"
  ADD CONSTRAINT "job_signoffs_signer_length" CHECK (char_length(btrim("signer_name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "job_signoffs_image_png" CHECK (
    "image" LIKE 'data:image/png;base64,%' AND char_length("image") <= 200000
  );

CREATE OR REPLACE FUNCTION assert_job_signoff_tenant()
RETURNS TRIGGER AS $$
DECLARE
  job_org uuid;
BEGIN
  SELECT "organization_id" INTO job_org FROM "jobs" WHERE "id" = NEW."job_id";
  IF job_org IS NULL OR job_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_signoffs: job % and row % are not one organization',
      job_org, NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_signoff_tenant_check
  BEFORE INSERT ON "job_signoffs"
  FOR EACH ROW EXECUTE FUNCTION assert_job_signoff_tenant();

-- Row-level security. No staff policy: a customer's signature is what the
-- business keeps, not account information.
ALTER TABLE "job_signoffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_signoffs" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_signoff_isolation ON "job_signoffs"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- A signature is never changed or removed by the application.
REVOKE UPDATE, DELETE, TRUNCATE ON "job_signoffs" FROM platform_app;
