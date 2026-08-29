-- Seed CRM permissions, grant them to the system roles, and register the
-- Shared Customers module.

-- ---------------------------------------------------------------------------
-- 1. Permissions.
-- ---------------------------------------------------------------------------
-- Four rather than one. "May see customers" and "may change them" are
-- genuinely different jobs in a field-service business: a crew member needs
-- the address and the gate code, and must not be able to rewrite the record.
--
-- customer.configure is separated from customer.write because defining a
-- custom field or renaming a tag changes the shape of the data for EVERYONE.
-- That is an owner decision, not a daily one.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('customer.read',      'crm', 'View customers, contacts and notes'),
  ('customer.write',     'crm', 'Create and edit customers, contacts and notes'),
  ('customer.delete',    'crm', 'Permanently delete a customer'),
  ('customer.configure', 'crm', 'Define custom fields and manage the tag vocabulary')
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Grants.
-- ---------------------------------------------------------------------------
-- Organization Administrator receives every permission by the blanket grant in
-- the Phase 4 seed, which selected from "permissions" as it stood then. New
-- keys are not retroactive, so they are granted explicitly here.

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-000000000001', "key"
FROM "permissions" WHERE "module" = 'crm'
ON CONFLICT DO NOTHING;

-- Location Manager: runs the book of business at their branches. Not
-- customer.delete — permanently destroying a customer record, with its notes
-- and history, is an owner decision. Not customer.configure either: changing
-- the field definitions affects every location, not just theirs.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000002', 'customer.read'),
  ('00000000-0000-4000-a000-000000000002', 'customer.write')
ON CONFLICT DO NOTHING;

-- Employee: can look a customer up at the locations they work, and nothing
-- more. Scoped by the LOCATION grant on the role assignment, so this does not
-- expose the whole book.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000003', 'customer.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The Shared Customers module.
-- ---------------------------------------------------------------------------
-- Serving one customer from several branches is a bigger-business problem, so
-- it is packaged like Custom Roles: a module the higher plans include rather
-- than a hard-coded plan check anywhere in application code.
--
-- Depends on CRM, since sharing a customer is meaningless without customers.

INSERT INTO "modules" ("key", "name", "description", "is_core", "dependencies", "created_at", "updated_at") VALUES
  ('shared_customers', 'Shared Customers',
   'Serve one customer from several locations, instead of just their home branch.',
   false, ARRAY['crm']::text[], now(), now())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "dependencies" = EXCLUDED."dependencies",
  "updated_at" = now();

-- Enterprise includes it. The trial includes everything, so that evaluation is
-- not hobbled by packaging.
INSERT INTO "plan_modules" ("plan_key", "module_key") VALUES
  ('enterprise', 'shared_customers'),
  ('trial', 'shared_customers')
ON CONFLICT DO NOTHING;
