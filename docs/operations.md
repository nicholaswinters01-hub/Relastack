# Running it

What tells us something is wrong, and what to do about it. The deployment
itself is in [deploy.md](deploy.md).

## Error alerts

An unexpected failure emails `SUPPORT_NOTIFY_EMAIL` (hello@relastack.com):

- a crash in a request
- the hourly sweep failing
- sending notifications failing
- a notification giving up after five attempts

The first alert goes at once. Anything in the next 15 minutes arrives together
in one digest, so a failure on every request cannot flood the inbox.

- **What an alert says:** where it happened (a route such as
  `GET /api/v1/customers/:id`, or the background job), the kind of error, and
  a reference.
- **What it never says:** an error's message or a request's contents, which
  can carry a business's customer data.
- **Finding the full error:** search the API's logs on Render for the
  reference. Every response carries its reference in `x-request-id`. A crash
  also returns it in the body, so a participant can quote it to the help desk.
- **What does not alert:** refusals, validation errors and a provider being
  down (502/503). Those are the system answering correctly.

Alerts are held in memory. That works while the API runs as one instance, the
same assumption the dispatcher makes.

## Uptime

Two checks, every five minutes, from an outside monitor such as UptimeRobot
(free):

| What               | Address                                                 |
| ------------------ | ------------------------------------------------------- |
| The API is running | `https://relastack-api.onrender.com/api/v1/health/live` |
| The app loads      | `https://app.relastack.com/login`                       |

- **Why not the database:** neither check touches it, so Neon can still sleep.
  A database outage shows up as error alerts instead, because every query
  fails.
- **Side effect on the free Render plan:** the API check keeps it awake. There
  is then no minute-long cold start for a participant, and background work runs
  on time. One service always on uses about 744 of the free 750 hours a month.

## Backups and restoring

Neon keeps the database's history and can restore to a point in time. How far
back depends on the Neon plan; check it under the project's settings.

**Drill.** Do this once before participants arrive, and after any plan change.
It changes nothing in production.

1. In Neon, create a **branch** from the production branch as it was an hour
   ago.
2. In the SQL Editor, on that branch, run `SELECT count(*) FROM customers;` and
   check the number is plausible.
3. Delete the branch.

**For real.** If data is lost:

1. Restore to a new branch just before the loss.
2. Check it as in the drill.
3. Point `DATABASE_URL` and `DATABASE_URL_APP` on Render at the new branch's
   connection strings. Recreate the `platform_app` password there first, if the
   branch needs it.

## Dependencies

`pnpm audit --prod` before each release. Advisories in libraries we do not
pull in directly are fixed with `pnpm.overrides` in the root `package.json`.
Remove an override once the library that brought the old version in has moved
past it.
