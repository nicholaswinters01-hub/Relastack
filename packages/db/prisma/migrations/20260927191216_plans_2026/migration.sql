-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "annual_billing_months" INTEGER NOT NULL DEFAULT 12;

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_annual_billing_months_range" CHECK ("annual_billing_months" BETWEEN 1 AND 12);

-- ===========================================================================
-- The 2026 price list, approved by the product owner on 2026-09-27.
--
-- Every plan includes one location; each further location is a flat $30 a
-- month on every plan. Users are never a price input. A year paid up front is
-- charged as ten months. Industry packs ($35/mo, one included in Pro and two
-- in Business) do not exist as modules yet; the descriptions say so.
--
-- The old plans are retired, not deleted: whoever is on one keeps it.
-- ===========================================================================

UPDATE "plans" SET "is_public" = false, "name" = "name" || ' (legacy)', "updated_at" = now()
WHERE "key" IN ('starter', 'business', 'enterprise') AND "name" NOT LIKE '%(legacy)';

INSERT INTO "plans" (
  "key", "name", "description",
  "base_price_cents", "per_location_price_cents", "included_locations",
  "max_locations", "max_users", "is_public", "grace_period_days", "trial_days",
  "annual_billing_months", "created_at", "updated_at"
) VALUES
  ('core', 'Core',
   'Everything to run your day: customers, scheduling, recurring jobs, tasks and your whole team. Industry packs $35/mo each (coming soon).',
   5000, 3000, 1, NULL, NULL, true, 14, 14, 10, now(), now()),

  ('pro', 'Pro',
   'Core, plus one industry pack of your choice, automation, a customer portal and QuickBooks sync (coming soon). Faster help-desk replies.',
   12900, 3000, 1, NULL, NULL, true, 14, 14, 10, now(), now()),

  ('business_v2', 'Business',
   'Pro, plus two industry packs and inventory (coming soon), customers shared across branches, and custom roles. Priority support with setup help.',
   29900, 3000, 1, NULL, NULL, true, 14, 14, 10, now(), now())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "base_price_cents" = EXCLUDED."base_price_cents",
  "per_location_price_cents" = EXCLUDED."per_location_price_cents",
  "included_locations" = EXCLUDED."included_locations",
  "max_locations" = EXCLUDED."max_locations",
  "is_public" = EXCLUDED."is_public",
  "grace_period_days" = EXCLUDED."grace_period_days",
  "trial_days" = EXCLUDED."trial_days",
  "annual_billing_months" = EXCLUDED."annual_billing_months",
  "updated_at" = now();

INSERT INTO "plan_modules" ("plan_key", "module_key") VALUES
  ('core', 'core'),
  ('core', 'crm'),
  ('core', 'scheduling'),
  ('core', 'reporting'),

  ('pro', 'core'),
  ('pro', 'crm'),
  ('pro', 'scheduling'),
  ('pro', 'reporting'),
  ('pro', 'automation'),

  ('business_v2', 'core'),
  ('business_v2', 'crm'),
  ('business_v2', 'scheduling'),
  ('business_v2', 'reporting'),
  ('business_v2', 'automation'),
  ('business_v2', 'inventory'),
  ('business_v2', 'custom_roles'),
  ('business_v2', 'shared_customers')
ON CONFLICT DO NOTHING;
