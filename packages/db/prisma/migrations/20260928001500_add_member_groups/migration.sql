-- Employee groups: labels a business gives its people. They grant nothing.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateTable
CREATE TABLE "member_groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_group_members" (
    "group_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_group_members_pkey" PRIMARY KEY ("group_id","membership_id")
);

-- CreateIndex
CREATE INDEX "member_groups_organization_id_idx" ON "member_groups"("organization_id");

-- CreateIndex
CREATE INDEX "member_group_members_organization_id_idx" ON "member_group_members"("organization_id");

-- CreateIndex
CREATE INDEX "member_group_members_membership_id_idx" ON "member_group_members"("membership_id");

-- AddForeignKey
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_group_members" ADD CONSTRAINT "member_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "member_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_group_members" ADD CONSTRAINT "member_group_members_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- One name per business, whatever the capitals.
CREATE UNIQUE INDEX "member_groups_organization_name_key"
  ON "member_groups" ("organization_id", lower("name"));

ALTER TABLE "member_groups"
  ADD CONSTRAINT "member_groups_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  ADD CONSTRAINT "member_groups_color_palette" CHECK (
    "color" IN ('slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink')
  );

-- The group, the person and the row must all belong to one business. The
-- policy alone would accept a row whose organization matches the tenant while
-- its group or person belongs to another.
CREATE OR REPLACE FUNCTION assert_member_group_member_tenant()
RETURNS TRIGGER AS $$
DECLARE
  group_org uuid;
  member_org uuid;
BEGIN
  SELECT "organization_id" INTO group_org FROM "member_groups" WHERE "id" = NEW."group_id";
  SELECT "organization_id" INTO member_org FROM "organization_memberships" WHERE "id" = NEW."membership_id";

  IF group_org IS NULL OR member_org IS NULL
     OR group_org <> NEW."organization_id" OR member_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'member_group_members: group %, person % and row % are not one organization',
      group_org, member_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Insert only: rows are never updated, and a cascade deletes rather than
-- nulls, so there is nothing else to re-check.
CREATE TRIGGER member_group_member_tenant_check
  BEFORE INSERT ON "member_group_members"
  FOR EACH ROW EXECUTE FUNCTION assert_member_group_member_tenant();

-- Row-level security: each business sees only its own. No staff policy — the
-- staff console has no need to know how a business organises its people.
ALTER TABLE "member_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY member_group_isolation ON "member_groups"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "member_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_group_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY member_group_member_isolation ON "member_group_members"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
