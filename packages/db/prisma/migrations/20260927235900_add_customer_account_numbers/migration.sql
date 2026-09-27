-- Customer account numbers: #1001, #1002, … per business, never reused.
--
-- The database hands them out, in a trigger, so every way a customer is
-- created gets one — the API, an import, a test fixture — and two customers
-- created at the same instant cannot be given the same number: the counter
-- row is locked by the UPDATE until the transaction ends.
--
-- (Prisma generated two DROP INDEX lines for the trigram search indexes. They
-- were removed: those indexes are hand-made and must stay.)

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "account_number" INTEGER;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "next_customer_number" INTEGER NOT NULL DEFAULT 1001;

-- ---------------------------------------------------------------------------
-- Number the customers that already exist, oldest first, per business.
-- ---------------------------------------------------------------------------

WITH numbered AS (
  SELECT "id",
         1000 + ROW_NUMBER() OVER (PARTITION BY "organization_id" ORDER BY "created_at", "id") AS n
  FROM "customers"
)
UPDATE "customers" c SET "account_number" = numbered.n
FROM numbered WHERE numbered."id" = c."id";

UPDATE "organizations" o SET "next_customer_number" = COALESCE(
  (SELECT MAX("account_number") + 1 FROM "customers" c WHERE c."organization_id" = o."id"),
  1001);

-- ---------------------------------------------------------------------------
-- Required, unique within a business, and sane.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_account_number_key" ON "customers"("organization_id", "account_number");

-- Prisma sees the column as optional so creates need not supply it; this is
-- what actually makes it required. The trigger below fills it before the
-- check runs.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_account_number_required" CHECK ("account_number" IS NOT NULL),
  ADD CONSTRAINT "customers_account_number_range" CHECK ("account_number" BETWEEN 1 AND 99999999);

-- ---------------------------------------------------------------------------
-- Handing out numbers.
--
-- Insert without a number: take the next one. Insert or change to a chosen
-- number (an owner matching their old system): keep it, and if it is at or
-- past the counter, move the counter beyond it — so an automatic number can
-- never collide with a chosen one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assign_customer_account_number()
RETURNS TRIGGER AS $$
DECLARE
  next_number integer;
BEGIN
  IF NEW."account_number" IS NULL THEN
    UPDATE "organizations"
    SET "next_customer_number" = "next_customer_number" + 1
    WHERE "id" = NEW."organization_id"
    RETURNING "next_customer_number" - 1 INTO next_number;

    IF next_number IS NULL THEN
      RAISE EXCEPTION 'No organization % to number customer % from',
        NEW."organization_id", NEW."id";
    END IF;

    NEW."account_number" := next_number;
  ELSIF TG_OP = 'INSERT' OR NEW."account_number" IS DISTINCT FROM OLD."account_number" THEN
    UPDATE "organizations"
    SET "next_customer_number" = GREATEST("next_customer_number", NEW."account_number" + 1)
    WHERE "id" = NEW."organization_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_account_number
  BEFORE INSERT OR UPDATE OF "account_number" ON "customers"
  FOR EACH ROW EXECUTE FUNCTION assign_customer_account_number();
