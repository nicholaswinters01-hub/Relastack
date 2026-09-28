-- "Need a manager": calls from the field, one open per job.
-- (Prisma's DROP INDEX lines for the hand-made trigram indexes were removed.)

-- CreateEnum
CREATE TYPE "help_request_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "job_help_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "help_request_status" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "requested_by_id" UUID,
    "requested_by_name" TEXT NOT NULL,
    "acknowledged_by_name" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_by_name" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_help_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_help_requests_organization_id_idx" ON "job_help_requests"("organization_id");

-- CreateIndex
CREATE INDEX "job_help_requests_job_id_idx" ON "job_help_requests"("job_id");

-- AddForeignKey
ALTER TABLE "job_help_requests" ADD CONSTRAINT "job_help_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_help_requests" ADD CONSTRAINT "job_help_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_help_requests" ADD CONSTRAINT "job_help_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below.
-- ===========================================================================

-- One call at a time per job: a second press while one is open would only
-- send the same message twice.
CREATE UNIQUE INDEX "job_help_requests_one_open"
  ON "job_help_requests" ("job_id") WHERE "status" <> 'RESOLVED';

ALTER TABLE "job_help_requests"
  ADD CONSTRAINT "job_help_requests_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500),
  ADD CONSTRAINT "job_help_requests_stages" CHECK (
    ("status" = 'OPEN' AND "acknowledged_at" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'ACKNOWLEDGED' AND "acknowledged_at" IS NOT NULL AND "resolved_at" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
  );

-- A call belongs to its job's business.
CREATE OR REPLACE FUNCTION assert_job_help_request_tenant()
RETURNS TRIGGER AS $$
DECLARE
  job_org uuid;
BEGIN
  SELECT "organization_id" INTO job_org FROM "jobs" WHERE "id" = NEW."job_id";
  IF job_org IS NULL OR job_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'job_help_requests: job % and row % are not one organization',
      job_org, NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Insert only: the job never changes, and the requester leaving nulls a
-- column this does not check.
CREATE TRIGGER job_help_request_tenant_check
  BEFORE INSERT ON "job_help_requests"
  FOR EACH ROW EXECUTE FUNCTION assert_job_help_request_tenant();

-- Row-level security. No staff policy: this is the business's own work.
ALTER TABLE "job_help_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_help_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_help_request_isolation ON "job_help_requests"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
