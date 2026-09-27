-- CreateTable
CREATE TABLE "platform_staff" (
    "user_id" UUID NOT NULL,
    "note" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "staff_audit_events" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "staff_email" TEXT NOT NULL,
    "organization_id" UUID,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_email" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_audit_events_organization_id_created_at_idx" ON "staff_audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "staff_audit_events_created_at_idx" ON "staff_audit_events"("created_at");

-- CreateIndex
CREATE INDEX "staff_notes_organization_id_created_at_idx" ON "staff_notes"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_staff" ADD CONSTRAINT "platform_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security for the staff console.
-- ---------------------------------------------------------------------------
--
-- Staff see ACCOUNT information across businesses: the business itself, its
-- subscription, people, locations, modules and pending invitations. They do
-- NOT see what a business keeps about its own customers — customers, jobs,
-- tasks, notes. That promise is kept here, by the database, rather than by
-- application code choosing not to ask: those tables get no staff policy at
-- all, so a staff query against them returns nothing.
--
-- Every staff branch needs two things at once: the request declared itself a
-- staff request (app.staff = 'on', set only by withStaff), AND the database's
-- own platform_staff table lists the user behind it. Setting the flag alone,
-- from any code path, grants nothing to someone who is not staff.
--
-- The existing tenant policies are untouched. These are ADDITIONAL permissive
-- policies, one per command, so staff get exactly the verbs listed and no
-- others — in particular no DELETE anywhere, which a single FOR ALL policy
-- would have granted along with SELECT.

-- Who is staff. Readable only as your own row, never writable by the app.
ALTER TABLE "platform_staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_staff" FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_staff_self ON "platform_staff"
  FOR SELECT
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "platform_staff" FROM platform_app;

-- Read-only account information.
CREATE POLICY organizations_staff_read ON "organizations" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY memberships_staff_read ON "organization_memberships" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY subscriptions_staff_read ON "subscriptions" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY subscription_add_ons_staff_read ON "subscription_add_ons" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY organization_modules_staff_read ON "organization_modules" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY locations_staff_read ON "locations" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY invitations_staff_read ON "invitations" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- The three things staff change: a business's status (suspend / reactivate),
-- its subscription (trial, plan), and an invitation (re-issuing its link).
CREATE POLICY organizations_staff_update ON "organizations" FOR UPDATE
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid))
  WITH CHECK (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY subscriptions_staff_update ON "subscriptions" FOR UPDATE
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid))
  WITH CHECK (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY invitations_staff_update ON "invitations" FOR UPDATE
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid))
  WITH CHECK (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- Removing a paid add-on: when staff move a business to a plan that already
-- includes that module, so it is not charged twice, or on request.
CREATE POLICY subscription_add_ons_staff_delete ON "subscription_add_ons" FOR DELETE
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- The audit trail: staff can add to it and read it, nobody can change it.
ALTER TABLE "staff_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_audit_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_audit_read ON "staff_audit_events" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- An entry must name the staff member actually making the request.
CREATE POLICY staff_audit_write ON "staff_audit_events" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "staff_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

REVOKE UPDATE, DELETE, TRUNCATE ON "staff_audit_events" FROM platform_app;

-- Internal notes. Staff only; a business never sees notes about itself.
ALTER TABLE "staff_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_notes" FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_notes_read ON "staff_notes" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY staff_notes_write ON "staff_notes" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "author_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

REVOKE UPDATE, DELETE, TRUNCATE ON "staff_notes" FROM platform_app;
