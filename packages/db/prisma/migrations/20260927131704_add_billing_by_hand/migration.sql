-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CARD', 'BANK_TRANSFER', 'CHECK', 'CASH', 'COMPLIMENTARY', 'OTHER');

-- CreateEnum
CREATE TYPE "credit_kind" AS ENUM ('GRANTED', 'APPLIED', 'RESTORED', 'REMOVED');



-- CreateTable
CREATE TABLE "billing_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "credit_applied_cents" INTEGER NOT NULL DEFAULT 0,
    "method" "payment_method" NOT NULL,
    "interval" "billing_interval" NOT NULL,
    "plan_key" TEXT NOT NULL,
    "reference" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "covers_from" TIMESTAMP(3) NOT NULL,
    "covers_until" TIMESTAMP(3) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_by_email" TEXT NOT NULL,
    "note" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" UUID,
    "voided_by_email" TEXT,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credits" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "credit_kind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "payment_id" UUID,
    "staff_user_id" UUID NOT NULL,
    "staff_email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_payments_organization_id_covers_until_idx" ON "billing_payments"("organization_id", "covers_until");

-- CreateIndex
CREATE INDEX "billing_payments_paid_at_idx" ON "billing_payments"("paid_at");

-- CreateIndex
CREATE INDEX "billing_credits_organization_id_created_at_idx" ON "billing_credits"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below. Prisma does not model any of it; keep it when
-- regenerating.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Money that cannot be nonsense, whatever the application sends.
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_payments"
  ADD CONSTRAINT "billing_payments_amount_not_negative" CHECK ("amount_cents" >= 0),
  ADD CONSTRAINT "billing_payments_credit_not_negative" CHECK ("credit_applied_cents" >= 0),
  ADD CONSTRAINT "billing_payments_covers_forward" CHECK ("covers_until" > "covers_from"),
  -- Voided completely or not at all: who, when and why travel together.
  ADD CONSTRAINT "billing_payments_void_complete" CHECK (
    ("voided_at" IS NULL AND "voided_by_user_id" IS NULL AND "voided_by_email" IS NULL AND "void_reason" IS NULL)
    OR
    ("voided_at" IS NOT NULL AND "voided_by_user_id" IS NOT NULL AND "voided_by_email" IS NOT NULL AND "void_reason" IS NOT NULL)
  );

-- The sign follows the kind, so a "grant" can never quietly take money away.
ALTER TABLE "billing_credits"
  ADD CONSTRAINT "billing_credits_sign_matches_kind" CHECK (
    ("kind" IN ('GRANTED', 'RESTORED') AND "amount_cents" > 0)
    OR ("kind" IN ('APPLIED', 'REMOVED') AND "amount_cents" < 0)
  ),
  ADD CONSTRAINT "billing_credits_payment_when_spent" CHECK (
    "kind" NOT IN ('APPLIED', 'RESTORED') OR "payment_id" IS NOT NULL
  );

-- A credit spent on a payment must be spent on one of the same business.
CREATE OR REPLACE FUNCTION assert_credit_payment_tenant()
RETURNS TRIGGER AS $$
DECLARE
  payment_org uuid;
BEGIN
  IF NEW."payment_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "organization_id" INTO payment_org
  FROM "billing_payments" WHERE "id" = NEW."payment_id";

  IF payment_org IS NULL OR payment_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      'billing_credits.organization_id (%) does not match the payment organization (%)',
      NEW."organization_id", payment_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_credit_payment_tenant_check
  BEFORE INSERT ON "billing_credits"
  FOR EACH ROW EXECUTE FUNCTION assert_credit_payment_tenant();

-- ---------------------------------------------------------------------------
-- 2. Row-level security.
--
-- A business may READ its own payments and credit, so its billing page can
-- show what it has paid. Only staff may write, and only as themselves.
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_payments" FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_payments_tenant_read ON "billing_payments" FOR SELECT
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY billing_payments_staff_read ON "billing_payments" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY billing_payments_staff_record ON "billing_payments" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "recorded_by_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND "voided_at" IS NULL
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

-- Voiding is the only change there is, it happens once, and it names the
-- person doing it.
CREATE POLICY billing_payments_staff_void ON "billing_payments" FOR UPDATE
  USING (current_setting('app.staff', true) = 'on'
    AND "voided_at" IS NULL
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid))
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "voided_at" IS NOT NULL
    AND "voided_by_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- And only the void columns can change. The amount, the dates and who
-- recorded it are beyond the application's reach entirely.
REVOKE UPDATE, DELETE, TRUNCATE ON "billing_payments" FROM platform_app;
GRANT UPDATE ("voided_at", "voided_by_user_id", "voided_by_email", "void_reason")
  ON "billing_payments" TO platform_app;

ALTER TABLE "billing_credits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_credits" FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_credits_tenant_read ON "billing_credits" FOR SELECT
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY billing_credits_staff_read ON "billing_credits" FOR SELECT
  USING (current_setting('app.staff', true) = 'on' AND EXISTS (
    SELECT 1 FROM "platform_staff" s
    WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

CREATE POLICY billing_credits_staff_write ON "billing_credits" FOR INSERT
  WITH CHECK (current_setting('app.staff', true) = 'on'
    AND "staff_user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "platform_staff" s
      WHERE s."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid));

REVOKE UPDATE, DELETE, TRUNCATE ON "billing_credits" FROM platform_app;
