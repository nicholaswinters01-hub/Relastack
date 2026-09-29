-- Customer export: a permission of its own, because a file of every customer
-- is a different thing from reading them one at a time. Admins hold it
-- organization-wide; a location manager holds it at their branches, through
-- the scope of their role. Employees do not.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('customer.export', 'crm', 'Download customers, contacts and notes as spreadsheets')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000001', 'customer.export'),
  ('00000000-0000-4000-a000-000000000002', 'customer.export')
ON CONFLICT DO NOTHING;
