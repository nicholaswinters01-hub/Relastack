-- Seed job permissions and grant them to the system roles.

-- ---------------------------------------------------------------------------
-- 1. Permissions.
-- ---------------------------------------------------------------------------
-- Module 'scheduling', unlike tasks: scheduling is a paid module, so its
-- permissions belong to it. The module guard refuses the routes outright when
-- an organization is not entitled; these decide who may do what once it is on.

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('job.read',   'scheduling', 'View the schedule'),
  ('job.write',  'scheduling', 'Book, edit and assign jobs'),
  ('job.delete', 'scheduling', 'Permanently delete a job')
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Grants.
-- ---------------------------------------------------------------------------

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-000000000001', "key"
FROM "permissions" WHERE "key" LIKE 'job.%'
ON CONFLICT DO NOTHING;

-- Location Manager books the work at their branches. Not job.delete:
-- cancelling records that the visit was not made, which is a number the
-- business needs; deleting destroys the fact it was ever booked.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000002', 'job.read'),
  ('00000000-0000-4000-a000-000000000002', 'job.write')
ON CONFLICT DO NOTHING;

-- Employee reads the schedule.
--
-- As with tasks, read is the floor rather than the ceiling: whoever is ON a
-- job can move its status without job.write. A crew that cannot mark a visit
-- complete from the van is a crew that stops using the software.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-4000-a000-000000000003', 'job.read')
ON CONFLICT DO NOTHING;
