-- Grant `location.write` to the Location Manager role.
--
-- It was omitted on the reasoning that a Location Manager should not be able
-- to create locations — creating one adds a billable unit, which is an owner
-- decision. That conclusion was right; removing the permission was the wrong
-- way to achieve it, because `location.write` covers editing as well as
-- creating, and a manager who cannot edit their own branch cannot do the job.
--
-- The two are separated by SCOPE, not by permission:
--
--   create  -> checked organization-wide  -> a scoped manager is refused
--   edit    -> checked at the location    -> a scoped manager is allowed there
--
-- This is precisely what the scope model exists to express, and doing it with
-- one permission keeps the catalogue small.

INSERT INTO "role_permissions" ("role_id", "permission_key")
VALUES ('00000000-0000-4000-a000-000000000002', 'location.write')
ON CONFLICT DO NOTHING;
