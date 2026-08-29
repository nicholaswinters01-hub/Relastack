-- A narrow read hatch for platform background work.
--
-- The outbox dispatcher and the periodic sweeps have to see rows belonging to
-- every organization: an outbox serving one tenant is not an outbox, and a
-- sweep that only lapses one company's subscription is not a sweep. There is
-- no single tenant to set, and running with none sees NOTHING because the
-- policies fail closed -- which is correct, and is why this has to be explicit.
--
-- Three tables only, chosen because they are what a worker must SCAN to know
-- what needs doing:
--
--   domain_events   the queue itself
--   subscriptions   which grace periods have run out
--   job_series      which recurring bookings need extending
--
-- Nothing is granted on customers, tasks, jobs or notifications. Everything a
-- worker WRITES still goes through ordinary tenant context, one organization
-- at a time, so the work it performs is as scoped as any request.
--
-- This is not a superuser connection. The application still connects as
-- platform_app and every other policy still applies. See the Phase 4
-- invitation-token branch for the same shape of exception.

DROP POLICY domain_event_isolation ON "domain_events";
CREATE POLICY domain_event_isolation ON "domain_events"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  );

DROP POLICY subscription_isolation ON "subscriptions";
CREATE POLICY subscription_isolation ON "subscriptions"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  );

DROP POLICY job_series_isolation ON "job_series";
CREATE POLICY job_series_isolation ON "job_series"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR current_setting('app.platform_worker', true) = 'on'
  );
