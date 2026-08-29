-- CreateEnum
CREATE TYPE "CustomerStage" AS ENUM ('LEAD', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT');

-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('CUSTOMER');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "stage" "CustomerStage" NOT NULL DEFAULT 'LEAD',
    "type" "CustomerType" NOT NULL DEFAULT 'PERSON',
    "display_name" TEXT NOT NULL,
    "company_name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "source" TEXT,
    "location_id" UUID,
    "owner_membership_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "converted_at" TIMESTAMP(3),
    "last_contacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_locations" (
    "customer_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_locations_pkey" PRIMARY KEY ("customer_id","location_id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "author_membership_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'neutral',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tags" (
    "customer_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("customer_id","tag_id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL DEFAULT 'CUSTOMER',
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB NOT NULL DEFAULT '[]',
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organization_id_stage_idx" ON "customers"("organization_id", "stage");

-- CreateIndex
CREATE INDEX "customers_organization_id_location_id_idx" ON "customers"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "customers_organization_id_display_name_idx" ON "customers"("organization_id", "display_name");

-- CreateIndex
CREATE INDEX "customers_organization_id_owner_membership_id_idx" ON "customers"("organization_id", "owner_membership_id");

-- CreateIndex
CREATE INDEX "customer_locations_organization_id_idx" ON "customer_locations"("organization_id");

-- CreateIndex
CREATE INDEX "customer_locations_location_id_idx" ON "customer_locations"("location_id");

-- CreateIndex
CREATE INDEX "contacts_organization_id_idx" ON "contacts"("organization_id");

-- CreateIndex
CREATE INDEX "contacts_customer_id_idx" ON "contacts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_notes_organization_id_idx" ON "customer_notes"("organization_id");

-- CreateIndex
CREATE INDEX "customer_notes_customer_id_created_at_idx" ON "customer_notes"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "tags_organization_id_idx" ON "tags"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "customer_tags_organization_id_idx" ON "customer_tags"("organization_id");

-- CreateIndex
CREATE INDEX "custom_field_definitions_organization_id_entity_idx" ON "custom_field_definitions"("organization_id", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_organization_id_entity_key_key" ON "custom_field_definitions"("organization_id", "entity", "key");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_membership_id_fkey" FOREIGN KEY ("owner_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_membership_id_fkey" FOREIGN KEY ("author_membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
-- Every CRM table is tenant-owned. These are the first tables holding real
-- business data, so a gap here leaks a competitor customer list rather than a
-- configuration flag. Same shape as every previous phase: ENABLE and FORCE,
-- keyed on the transaction-local organization id, failing closed when unset.

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_isolation ON "customers"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "customer_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_location_isolation ON "customer_locations"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_isolation ON "contacts"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "customer_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_note_isolation ON "customer_notes"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tag_isolation ON "tags"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "customer_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_tag_isolation ON "customer_tags"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_field_definition_isolation ON "custom_field_definitions"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Denormalised organization_id must match the parent row.
-- ---------------------------------------------------------------------------
-- Each join table carries organization_id so RLS can key on it directly. The
-- policy alone would accept a row whose organization_id satisfies the current
-- tenant while the record it points at belongs to another. Phase 6 hit exactly
-- this on subscription add-ons; the same guard applies here.

CREATE OR REPLACE FUNCTION assert_customer_child_tenant()
RETURNS TRIGGER AS $$
DECLARE
  customer_org uuid;
BEGIN
  SELECT "organization_id" INTO customer_org
  FROM "customers" WHERE "id" = NEW."customer_id";

  IF customer_org IS NULL OR customer_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      '%.organization_id (%) does not match the customer organization (%)',
      TG_TABLE_NAME, NEW."organization_id", customer_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contact_tenant_check
  BEFORE INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_child_tenant();

CREATE TRIGGER customer_note_tenant_check
  BEFORE INSERT OR UPDATE ON "customer_notes"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_child_tenant();

CREATE TRIGGER customer_tag_tenant_check
  BEFORE INSERT OR UPDATE ON "customer_tags"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_child_tenant();

CREATE TRIGGER customer_location_tenant_check
  BEFORE INSERT OR UPDATE ON "customer_locations"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_child_tenant();

-- A tag applied to a customer must also belong to the same organization.
-- Without this, a tag id guessed from another tenant could be attached.
CREATE OR REPLACE FUNCTION assert_customer_tag_tag_tenant()
RETURNS TRIGGER AS $$
DECLARE
  tag_org uuid;
BEGIN
  SELECT "organization_id" INTO tag_org FROM "tags" WHERE "id" = NEW."tag_id";

  IF tag_org IS NULL OR tag_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      'customer_tags.tag_id belongs to organization (%), not (%)',
      tag_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_tag_tag_tenant_check
  BEFORE INSERT OR UPDATE ON "customer_tags"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_tag_tag_tenant();

-- A customer may only be assigned to, or shared with, a location in the same
-- organization.
CREATE OR REPLACE FUNCTION assert_customer_location_tenant()
RETURNS TRIGGER AS $$
DECLARE
  location_org uuid;
BEGIN
  IF NEW."location_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "organization_id" INTO location_org
  FROM "locations" WHERE "id" = NEW."location_id";

  IF location_org IS NULL OR location_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      '%.location_id belongs to organization (%), not (%)',
      TG_TABLE_NAME, location_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_primary_location_tenant_check
  BEFORE INSERT OR UPDATE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_location_tenant();

CREATE TRIGGER customer_shared_location_tenant_check
  BEFORE INSERT OR UPDATE ON "customer_locations"
  FOR EACH ROW EXECUTE FUNCTION assert_customer_location_tenant();

-- ---------------------------------------------------------------------------
-- Search support.
-- ---------------------------------------------------------------------------
-- Added now rather than after the first slow customer list. Trigram indexes
-- make ILIKE '%term%' usable, which a plain b-tree cannot do for a leading
-- wildcard.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX customers_display_name_trgm
  ON "customers" USING gin ("display_name" gin_trgm_ops);
CREATE INDEX customers_email_trgm
  ON "customers" USING gin ("email" gin_trgm_ops);
