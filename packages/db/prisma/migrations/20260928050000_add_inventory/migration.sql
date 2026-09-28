-- Inventory: items, stock places (branches for now) and an append-only ledger.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateEnum
CREATE TYPE "stock_place_kind" AS ENUM ('BRANCH');

-- CreateEnum
CREATE TYPE "stock_movement_reason" AS ENUM ('RECEIVED', 'USED', 'COUNTED', 'DAMAGED', 'MOVED_OUT', 'MOVED_IN', 'CORRECTED');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT NOT NULL,
    "category" TEXT,
    "cost_cents" INTEGER,
    "low_stock_level" DECIMAL(12,3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_places" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "stock_place_kind" NOT NULL DEFAULT 'BRANCH',
    "location_id" UUID NOT NULL,
    "employees_can_take" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "place_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" "stock_movement_reason" NOT NULL,
    "counted_quantity" DECIMAL(12,3),
    "transfer_id" UUID,
    "note" TEXT,
    "recorded_by_id" UUID,
    "recorded_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_items_organization_id_idx" ON "inventory_items"("organization_id");

-- CreateIndex
CREATE INDEX "stock_places_organization_id_idx" ON "stock_places"("organization_id");

-- CreateIndex
CREATE INDEX "stock_places_location_id_idx" ON "stock_places"("location_id");

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_idx" ON "stock_movements"("organization_id");

-- CreateIndex
CREATE INDEX "stock_movements_item_id_place_id_idx" ON "stock_movements"("item_id", "place_id");

-- CreateIndex
CREATE INDEX "stock_movements_place_id_idx" ON "stock_movements"("place_id");

-- CreateIndex
CREATE INDEX "stock_movements_transfer_id_idx" ON "stock_movements"("transfer_id");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_places" ADD CONSTRAINT "stock_places_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_places" ADD CONSTRAINT "stock_places_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "stock_places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- Names are unique among a business's current items, whatever the capitals;
-- an archived "Mulch" does not stop a new one. A SKU is unique outright.
CREATE UNIQUE INDEX "inventory_items_organization_name_key"
  ON "inventory_items" ("organization_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "inventory_items_organization_sku_key"
  ON "inventory_items" ("organization_id", lower("sku")) WHERE "sku" IS NOT NULL;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "inventory_items_unit_length" CHECK (char_length(btrim("unit")) BETWEEN 1 AND 20),
  ADD CONSTRAINT "inventory_items_cost_positive" CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0),
  ADD CONSTRAINT "inventory_items_low_stock_positive" CHECK ("low_stock_level" IS NULL OR "low_stock_level" >= 0);

-- One place per branch.
CREATE UNIQUE INDEX "stock_places_branch_key"
  ON "stock_places" ("location_id") WHERE "kind" = 'BRANCH';

-- The sign of a change follows from its reason, so a "received" row can never
-- quietly take stock away. A count may be zero: counting and finding exactly
-- what was expected is worth recording.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_sign" CHECK (
    ("reason" IN ('RECEIVED', 'MOVED_IN') AND "quantity" > 0)
    OR ("reason" IN ('USED', 'DAMAGED', 'MOVED_OUT') AND "quantity" < 0)
    OR ("reason" = 'COUNTED' AND "counted_quantity" IS NOT NULL AND "counted_quantity" >= 0)
    OR ("reason" = 'CORRECTED' AND "quantity" <> 0)
  ),
  ADD CONSTRAINT "stock_movements_transfer" CHECK (
    ("reason" IN ('MOVED_OUT', 'MOVED_IN')) = ("transfer_id" IS NOT NULL)
  );

-- A place belongs to its branch's business.
CREATE OR REPLACE FUNCTION assert_stock_place_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
BEGIN
  SELECT "organization_id" INTO location_org FROM "locations" WHERE "id" = NEW."location_id";

  IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'stock_places: location % and row % are not one organization',
      location_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only when the branch changes, so an unrelated update is never re-checked.
CREATE TRIGGER stock_place_tenant_check
  BEFORE INSERT ON "stock_places"
  FOR EACH ROW EXECUTE FUNCTION assert_stock_place_tenant();
CREATE TRIGGER stock_place_tenant_recheck
  BEFORE UPDATE OF "location_id" ON "stock_places"
  FOR EACH ROW WHEN (NEW."location_id" IS DISTINCT FROM OLD."location_id")
  EXECUTE FUNCTION assert_stock_place_tenant();

-- The item, the place and the row must all belong to one business. The
-- policy alone would accept a row whose organization matches the tenant while
-- its item or place belongs to another.
CREATE OR REPLACE FUNCTION assert_stock_movement_tenant()
RETURNS TRIGGER AS $$
DECLARE
  item_org uuid;
  place_org uuid;
BEGIN
  SELECT "organization_id" INTO item_org FROM "inventory_items" WHERE "id" = NEW."item_id";
  SELECT "organization_id" INTO place_org FROM "stock_places" WHERE "id" = NEW."place_id";

  IF item_org IS NULL OR place_org IS NULL
     OR item_org <> NEW."organization_id" OR place_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'stock_movements: item %, place % and row % are not one organization',
      item_org, place_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Insert only: the application cannot update a movement at all, and a person
-- leaving nulls recorded_by_id through the foreign key, which needs no check.
CREATE TRIGGER stock_movement_tenant_check
  BEFORE INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION assert_stock_movement_tenant();

-- Every branch is a stock place from the moment it exists. Locations are only
-- created inside a tenant transaction, so the insert passes the policy below.
CREATE OR REPLACE FUNCTION create_branch_stock_place()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "stock_places" ("id", "organization_id", "kind", "location_id", "updated_at")
  VALUES (gen_random_uuid(), NEW."organization_id", 'BRANCH', NEW."id", CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER location_branch_stock_place
  AFTER INSERT ON "locations"
  FOR EACH ROW EXECUTE FUNCTION create_branch_stock_place();

-- Existing branches, before row-level security is switched on.
INSERT INTO "stock_places" ("id", "organization_id", "kind", "location_id", "updated_at")
SELECT gen_random_uuid(), "organization_id", 'BRANCH', "id", CURRENT_TIMESTAMP
FROM "locations"
ON CONFLICT DO NOTHING;

-- Row-level security: each business sees only its own. No staff policy:
-- stock is what a business keeps, not account information.
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_isolation ON "inventory_items"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "stock_places" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_places" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_place_isolation ON "stock_places"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movement_isolation ON "stock_movements"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- The ledger is append-only for the application. Only the foreign key may
-- clear who recorded a row, when that person is removed.
REVOKE UPDATE, DELETE, TRUNCATE ON "stock_movements" FROM platform_app;

-- ---------------------------------------------------------------------------
-- Permissions.
-- ---------------------------------------------------------------------------

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('inventory.read',      'inventory', 'See items and stock levels'),
  ('inventory.write',     'inventory', 'Receive, use, count and move stock'),
  ('inventory.configure', 'inventory', 'Add and edit items')
ON CONFLICT ("key") DO NOTHING;

-- Organization admin: everything.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-000000000001', "key"
FROM "permissions" WHERE "key" LIKE 'inventory.%'
ON CONFLICT DO NOTHING;

-- Location Manager runs the stock at their branches. Not configure: the item
-- list is the whole company's.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000002', 'inventory.read'),
  ('00000000-0000-4000-a000-000000000002', 'inventory.write')
ON CONFLICT DO NOTHING;

-- Employee reads. Whether they may take stock is each branch's own setting.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000003', 'inventory.read')
ON CONFLICT DO NOTHING;
