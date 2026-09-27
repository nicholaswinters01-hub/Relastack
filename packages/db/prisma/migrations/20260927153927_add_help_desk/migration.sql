-- CreateEnum
CREATE TYPE "support_kind" AS ENUM ('QUESTION', 'PROBLEM', 'IDEA');

-- CreateEnum
CREATE TYPE "support_status" AS ENUM ('OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED');



-- CreateTable
CREATE TABLE "support_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opened_by_email" TEXT NOT NULL,
    "kind" "support_kind" NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "support_status" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_email" TEXT NOT NULL,
    "from_staff" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_requests_organization_id_created_at_idx" ON "support_requests"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "support_requests_status_updated_at_idx" ON "support_requests"("status", "updated_at");

-- CreateIndex
CREATE INDEX "support_messages_request_id_created_at_idx" ON "support_messages"("request_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below. Prisma does not model any of it; keep it when
-- regenerating.
-- ===========================================================================

ALTER TABLE "support_requests"
  ADD CONSTRAINT "support_requests_subject_length" CHECK (char_length("subject") BETWEEN 1 AND 200);
ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_messages_body_length" CHECK (char_length("body") BETWEEN 1 AND 5000);

-- A message must belong to the same business as its request; the policy alone
-- would accept a row whose organization matches while its request is elsewhere.
CREATE OR REPLACE FUNCTION assert_support_message_tenant()
RETURNS TRIGGER AS $$
DECLARE
  request_org uuid;
BEGIN
  SELECT "organization_id" INTO request_org FROM "support_requests" WHERE "id" = NEW."request_id";
  IF request_org IS NULL OR request_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'support_messages.organization_id (%) does not match the request organization (%)',
      NEW."organization_id", request_org;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_message_tenant_check
  BEFORE INSERT ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION assert_support_message_tenant();

-- ---------------------------------------------------------------------------
-- Row-level security. A business reaches only its own; staff reach every
-- business's requests through withStaff(), and nothing else new.
-- ---------------------------------------------------------------------------

ALTER TABLE "support_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY support_requests_tenant_read ON "support_requests" FOR SELECT
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Opened only by the person signed in, in their own business.
CREATE POLICY support_requests_tenant_open ON "support_requests" FOR INSERT
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND "opened_by_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- Status moves when the business replies (a resolved request reopens).
CREATE POLICY support_requests_tenant_update ON "support_requests" FOR UPDATE
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY support_requests_staff_read ON "support_requests" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY support_requests_staff_update ON "support_requests" FOR UPDATE
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid))
  WITH CHECK (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- Only the status columns change after a request is opened.
REVOKE UPDATE, DELETE, TRUNCATE ON "support_requests" FROM platform_app;
GRANT UPDATE ("status", "resolved_at", "updated_at") ON "support_requests" TO platform_app;

ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY support_messages_tenant_read ON "support_messages" FOR SELECT
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- A business writes as itself, never as staff.
CREATE POLICY support_messages_tenant_write ON "support_messages" FOR INSERT
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND "author_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND "from_staff" = false);

CREATE POLICY support_messages_staff_read ON "support_messages" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY support_messages_staff_write ON "support_messages" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "from_staff" = true
    AND "author_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

REVOKE UPDATE, DELETE, TRUNCATE ON "support_messages" FROM platform_app;

-- A staff reply is announced in the same transaction as the reply itself, so
-- staff may add exactly this one kind of event, and nothing else.
CREATE POLICY domain_events_staff_support_reply ON "domain_events" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "type" = 'support.replied'
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));
