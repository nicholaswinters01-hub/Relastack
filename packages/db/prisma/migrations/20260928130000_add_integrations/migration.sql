-- Connected apps (Phase 11a): sealed OAuth grants, single-use OAuth states,
-- and an append-only log of every use.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('CONNECTED', 'NEEDS_RECONNECT');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'CONNECTED',
    "account_id" TEXT NOT NULL,
    "account_name" TEXT,
    "account_email" TEXT,
    "base_uri" TEXT,
    "access_token_sealed" TEXT NOT NULL,
    "refresh_token_sealed" TEXT NOT NULL,
    "access_expires_at" TIMESTAMP(3) NOT NULL,
    "connected_by_id" UUID,
    "connected_by_name" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_oauth_states" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "code_verifier_sealed" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "actor_id" UUID,
    "actor_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_idx" ON "integration_connections"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_organization_id_provider_key" ON "integration_connections"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_states_state_hash_key" ON "integration_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "integration_oauth_states_organization_id_idx" ON "integration_oauth_states"("organization_id");

-- CreateIndex
CREATE INDEX "integration_events_organization_id_created_at_idx" ON "integration_events"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- Providers RelaStack has an adapter for. A new one is a migration, so a
-- typo can never create a connection nothing will ever use.
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_provider" CHECK ("provider" IN ('docusign', 'dropbox_sign'));
ALTER TABLE "integration_oauth_states"
  ADD CONSTRAINT "integration_oauth_states_provider" CHECK ("provider" IN ('docusign', 'dropbox_sign'));

-- A sealed value is "v<version>.<iv>.<tag>.<ciphertext>". Refusing anything
-- else means a plain token can never be stored here by mistake.
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_sealed" CHECK (
    "access_token_sealed" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'
    AND "refresh_token_sealed" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'
  );
ALTER TABLE "integration_oauth_states"
  ADD CONSTRAINT "integration_oauth_states_sealed" CHECK (
    "code_verifier_sealed" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'
  );

-- An event about a connection belongs to that connection's business.
CREATE OR REPLACE FUNCTION assert_integration_event_tenant()
RETURNS TRIGGER AS $$
DECLARE
  connection_org uuid;
BEGIN
  IF NEW."connection_id" IS NOT NULL THEN
    SELECT "organization_id" INTO connection_org
      FROM "integration_connections" WHERE "id" = NEW."connection_id";
    IF connection_org IS NULL OR connection_org <> NEW."organization_id" THEN
      RAISE EXCEPTION 'integration_events: connection % and row % are not one organization',
        connection_org, NEW."organization_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integration_event_tenant_check
  BEFORE INSERT ON "integration_events"
  FOR EACH ROW EXECUTE FUNCTION assert_integration_event_tenant();

-- Row-level security on all three. No staff policy on any: a grant to act in
-- a business's DocuSign is not account information, and staff never need it.
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_connection_isolation ON "integration_connections"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "integration_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_oauth_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_oauth_state_isolation ON "integration_oauth_states"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "integration_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_event_isolation ON "integration_events"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- The log is append-only for the application.
REVOKE UPDATE, DELETE, TRUNCATE ON "integration_events" FROM platform_app;
