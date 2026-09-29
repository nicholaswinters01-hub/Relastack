-- Contracts: documents sent for signature from a business's own e-signature
-- account, and a secret webhook address per connection.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateEnum
CREATE TYPE "contract_status" AS ENUM ('SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'VOIDED');

-- AlterTable
ALTER TABLE "integration_connections" ADD COLUMN     "hook_token_hash" TEXT,
ADD COLUMN     "hook_token_sealed" TEXT;

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_envelope_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "status" "contract_status" NOT NULL DEFAULT 'SENT',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "sent_by_id" UUID,
    "sent_by_name" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contracts_organization_id_idx" ON "contracts"("organization_id");

-- CreateIndex
CREATE INDEX "contracts_customer_id_idx" ON "contracts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_organization_id_provider_provider_envelope_id_key" ON "contracts"("organization_id", "provider", "provider_envelope_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_hook_token_hash_key" ON "integration_connections"("hook_token_hash");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- The module: on Pro and Business, and the trial.
INSERT INTO "modules" ("key", "name", "description", "is_core", "dependencies", "created_at", "updated_at") VALUES
  ('contracts', 'Contracts',
   'Send agreements for signature from your own DocuSign, and see when they are signed.',
   false, ARRAY['crm']::text[], now(), now())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "dependencies" = EXCLUDED."dependencies",
  "updated_at" = now();

INSERT INTO "plan_modules" ("plan_key", "module_key")
SELECT "key", 'contracts' FROM "plans" WHERE "key" IN ('trial', 'pro', 'business_v2')
ON CONFLICT DO NOTHING;

-- The webhook secret is sealed like the grant itself, and the two columns
-- come as a pair.
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_hook_pair" CHECK (
    ("hook_token_sealed" IS NULL) = ("hook_token_hash" IS NULL)
  ),
  ADD CONSTRAINT "integration_connections_hook_sealed" CHECK (
    "hook_token_sealed" IS NULL
    OR "hook_token_sealed" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'
  );

ALTER TABLE "contracts"
  ADD CONSTRAINT "contracts_provider" CHECK ("provider" IN ('docusign', 'dropbox_sign')),
  ADD CONSTRAINT "contracts_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);

-- A contract belongs to its customer's business.
CREATE OR REPLACE FUNCTION assert_contract_tenant()
RETURNS TRIGGER AS $$
DECLARE
  customer_org uuid;
BEGIN
  SELECT "organization_id" INTO customer_org FROM "customers" WHERE "id" = NEW."customer_id";
  IF customer_org IS NULL OR customer_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'contracts: customer % and row % are not one organization',
      customer_org, NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Insert only: the customer never changes, and the sender leaving nulls a
-- column this does not check.
CREATE TRIGGER contract_tenant_check
  BEFORE INSERT ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION assert_contract_tenant();

-- Row-level security. No staff policy: a contract is between a business and
-- its customer.
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_isolation ON "contracts"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
