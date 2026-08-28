-- Seed plans, subscribe existing organizations, and protect the new
-- tenant-owned tables with row-level security.

-- ---------------------------------------------------------------------------
-- 1. Plans.
-- ---------------------------------------------------------------------------
-- Plans are DATA. Repricing, repackaging, or adding a tier is an insert here
-- and nothing else — no business logic reads a price or branches on a plan
-- name (docs/adr/0003).
--
-- Prices are in cents to avoid floating point entirely. A plan priced at
-- 4900 + 1500/location means $49 base plus $15 per location beyond those
-- included. Nothing is priced per user: the platform bills by location, and
-- max_users is NULL everywhere on purpose.

INSERT INTO "plans" (
  "key", "name", "description",
  "base_price_cents", "per_location_price_cents", "included_locations",
  "max_locations", "max_users", "is_public", "grace_period_days", "trial_days",
  "created_at", "updated_at"
) VALUES
  ('trial', 'Trial',
   'Everything unlocked while you evaluate the platform.',
   0, 0, 3, 3, NULL, false, 0, 14, now(), now()),

  ('starter', 'Starter',
   'One location, customer records, and the essentials.',
   2900, 0, 1, 1, NULL, true, 14, 14, now(), now()),

  ('business', 'Business',
   'Multiple locations with scheduling and reporting.',
   7900, 1500, 3, NULL, NULL, true, 14, 14, now(), now()),

  ('enterprise', 'Enterprise',
   'Every module, unlimited locations, and custom roles.',
   19900, 1200, 10, NULL, NULL, true, 30, 14, now(), now())
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
  "updated_at" = now();

-- ---------------------------------------------------------------------------
-- 2. What each plan includes.
-- ---------------------------------------------------------------------------
-- Anything not listed is purchasable as an add-on, which is what makes the
-- same catalogue serve both "included" and "extra" without a second concept.

-- Trial: everything, so evaluation is not hobbled by packaging.
INSERT INTO "plan_modules" ("plan_key", "module_key")
SELECT 'trial', "key" FROM "modules"
ON CONFLICT DO NOTHING;

INSERT INTO "plan_modules" ("plan_key", "module_key") VALUES
  ('starter', 'core'),
  ('starter', 'crm'),

  ('business', 'core'),
  ('business', 'crm'),
  ('business', 'scheduling'),
  ('business', 'reporting'),

  ('enterprise', 'core'),
  ('enterprise', 'crm'),
  ('enterprise', 'scheduling'),
  ('enterprise', 'reporting'),
  ('enterprise', 'inventory'),
  ('enterprise', 'automation'),
  ('enterprise', 'custom_roles')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Subscribe existing organizations to a trial.
-- ---------------------------------------------------------------------------
-- Every organization must have exactly one subscription, because entitlement
-- is derived from it. An organization without one would resolve to no modules
-- at all and be locked out of its own account.
--
-- Existing customers get a trial rather than a paid plan: charging someone
-- retroactively for a plan they never chose would be indefensible.

INSERT INTO "subscriptions" (
  "id", "organization_id", "plan_key", "status",
  "period_starts_at", "period_ends_at", "trial_ends_at",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), o."id", 'trial', 'TRIALING',
  now(), now() + interval '14 days', now() + interval '14 days',
  now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_isolation ON "subscriptions"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "subscription_add_ons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_add_ons" FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_add_on_isolation ON "subscription_add_ons"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Deliberately NOT protected by RLS: "plans" and "plan_modules".
--
-- Both are the public price list. Which plans exist and what each includes is
-- on the marketing site; hiding them from customers would serve nobody. What
-- is tenant-specific is which plan an organization is ON, and that lives in
-- subscriptions above.

-- ---------------------------------------------------------------------------
-- 5. The denormalised organization_id on an add-on must match its
--    subscription.
-- ---------------------------------------------------------------------------
-- The policy alone would accept a row whose organization_id satisfies the
-- current tenant while its subscription belongs elsewhere.

CREATE OR REPLACE FUNCTION assert_add_on_tenant()
RETURNS TRIGGER AS $$
DECLARE
  subscription_org uuid;
BEGIN
  SELECT "organization_id" INTO subscription_org
  FROM "subscriptions" WHERE "id" = NEW."subscription_id";

  IF subscription_org IS NULL OR subscription_org <> NEW."organization_id" THEN
    RAISE EXCEPTION
      'subscription_add_ons.organization_id (%) does not match the subscription organization (%)',
      NEW."organization_id", subscription_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscription_add_on_tenant_check
  BEFORE INSERT OR UPDATE ON "subscription_add_ons"
  FOR EACH ROW EXECUTE FUNCTION assert_add_on_tenant();
