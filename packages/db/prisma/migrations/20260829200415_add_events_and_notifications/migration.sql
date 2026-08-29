-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link_path" TEXT,
    "read_at" TIMESTAMP(3),
    "event_id" UUID,
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "membership_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("membership_id","type")
);

-- CreateIndex
CREATE INDEX "domain_events_processed_at_created_at_idx" ON "domain_events"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "domain_events_organization_id_type_created_at_idx" ON "domain_events"("organization_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "notifications_membership_id_read_at_created_at_idx" ON "notifications"("membership_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_idx" ON "notifications"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_event_id_membership_id_key" ON "notifications"("event_id", "membership_id");

-- CreateIndex
CREATE INDEX "notification_preferences_organization_id_idx" ON "notification_preferences"("organization_id");

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "domain_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_event_isolation ON "domain_events"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_isolation ON "notifications"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preference_isolation ON "notification_preferences"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- A notification must reach somebody in the same organization.
-- ---------------------------------------------------------------------------
-- The one leak this table could produce is telling a person in company A what
-- happened in company B. RLS keys on organization_id alone, so without this a
-- row could satisfy the policy while addressing a membership elsewhere.

CREATE OR REPLACE FUNCTION assert_notification_tenant()
RETURNS TRIGGER AS $$
DECLARE
  member_org uuid;
BEGIN
  SELECT "organization_id" INTO member_org FROM "organization_memberships"
    WHERE "id" = NEW."membership_id";

  IF member_org IS NULL OR member_org <> NEW."organization_id" THEN
    RAISE EXCEPTION '%.membership_id belongs to organization (%), not (%)',
      TG_TABLE_NAME, member_org, NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_tenant_check
  BEFORE INSERT OR UPDATE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION assert_notification_tenant();

CREATE TRIGGER notification_preference_tenant_check
  BEFORE INSERT OR UPDATE ON "notification_preferences"
  FOR EACH ROW EXECUTE FUNCTION assert_notification_tenant();

-- ---------------------------------------------------------------------------
-- The dispatcher's query.
-- ---------------------------------------------------------------------------
-- "Oldest unprocessed event" runs every few seconds forever. A partial index
-- keeps it reading only the backlog rather than the whole history, which grows
-- without bound.

CREATE INDEX domain_events_pending
  ON "domain_events" ("created_at")
  WHERE "processed_at" IS NULL;
