-- Seed task permissions and grant them to the system roles.

-- ---------------------------------------------------------------------------
-- 1. Permissions.
-- ---------------------------------------------------------------------------
-- Module 'core', not 'tasks'. Tasks are part of every plan: a platform that
-- cannot record "ring Mrs Patel back on Thursday" looks unfinished on the
-- cheapest tier, and Scheduling and Automation are both built on top of them.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('task.read',   'core', 'View tasks'),
  ('task.write',  'core', 'Create, edit and assign tasks'),
  ('task.delete', 'core', 'Permanently delete a task')
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Grants.
-- ---------------------------------------------------------------------------
-- The Phase 4 blanket grant to Organization Administrator selected from
-- "permissions" as it stood then, and new keys are not retroactive.

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-000000000001', "key"
FROM "permissions" WHERE "key" LIKE 'task.%'
ON CONFLICT DO NOTHING;

-- Location Manager runs the work at their branches. Not task.delete --
-- destroying the record of what was asked for is an owner decision, and
-- cancelling a task already expresses "this is not happening" without
-- erasing that it was ever wanted.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000002', 'task.read'),
  ('00000000-0000-4000-a000-000000000002', 'task.write')
ON CONFLICT DO NOTHING;

-- Employee gets read only.
--
-- Read here is the floor, not the ceiling: the service additionally lets
-- whoever a task is ASSIGNED to move its status, whatever their role. Being
-- given work you cannot then mark as done would be absurd, and it is the one
-- case where authority comes from the row rather than the role.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000003', 'task.read')
ON CONFLICT DO NOTHING;
