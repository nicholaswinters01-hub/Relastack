-- Performance on the manager's board: a permission of its own, because how
-- people are doing is more sensitive than who works here. Admins hold it
-- organization-wide; a location manager holds it at their branches, through
-- the scope of their role. Employees do not, and see only their own numbers.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('member.review', 'core', 'See how people are doing: jobs, contracts, leads and tasks')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000001', 'member.review'),
  ('00000000-0000-4000-a000-000000000002', 'member.review')
ON CONFLICT DO NOTHING;
