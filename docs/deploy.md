# Deploying the product

Three pieces, in this order. The marketing site (`apps/marketing`) is separate
and already has its own guide in `apps/marketing/DEPLOY.md`.

| Piece            | Where            | Address                      |
| ---------------- | ---------------- | ---------------------------- |
| Database         | Neon, us-east-1  | —                            |
| API (`apps/api`) | Render, Virginia | `relastack-api.onrender.com` |
| Web (`apps/web`) | Vercel, iad1     | `app.relastack.com`          |

All three sit in the same US East region, so a page render is not three
cross-country round trips.

## 1. Database (Neon)

1. Create a **new Neon project** for the product, region **AWS us-east-1**.
   Keep it separate from the waitlist's project so the two do not share a
   compute budget.
2. In the project's **SQL Editor**, create the application role with plain SQL:

   ```sql
   CREATE ROLE platform_app LOGIN PASSWORD '<a long random password>';
   ```

   **Not through Neon's Roles page.** Roles created there are given
   `neon_superuser`, which carries `BYPASSRLS` — row-level security would then
   enforce nothing. The migrations check for exactly this, including through
   group membership, and refuse to run.

3. Copy two **direct** (not pooled) connection strings:
   - the owner role (`neondb_owner`) → `DATABASE_URL`, used only to migrate
   - `platform_app` → `DATABASE_URL_APP`, used for every request

   Direct, because the API is one long-running process with its own pool and
   uses interactive transactions; the pooler would add a hop and a Prisma
   setting for nothing.

## 2. API (Render)

`render.yaml` describes the service. In Render: **New → Blueprint**, pick the
repository, and fill in the values it asks for:

- `DATABASE_URL`, `DATABASE_URL_APP` from step 1
- `SIGNUP_ACCESS_CODE` — the code you give invited businesses (8+ characters)

Render generates `INTERNAL_API_SECRET` itself.

The service runs on Render's **free** plan while in research: it sleeps
after 15 minutes without traffic and takes about a minute to wake. Migrations
run at startup, before the API listens; a failed migration stops the start,
so a broken schema never serves traffic. When businesses use it daily, switch
the plan to `starter` (always on, about $7/month) and move the migration into
a `preDeployCommand`, so a failure leaves the previous version serving instead.

The health check is `/api/v1/health/live`, which does not touch the database.
The full `/api/v1/health` does, and is refused without the internal secret —
polling it would keep Neon awake.

## 3. Web (Vercel)

1. **New project** from the same repository.
   - Root Directory: `apps/web`
   - Include source files outside of the Root Directory: **on**
   - Build command comes from `apps/web/vercel.json`; leave it default.
2. Environment variables (Production):
   - `API_URL` = the Render service's URL, e.g. `https://relastack-api.onrender.com`
   - `INTERNAL_API_SECRET` = copied from the Render service's environment
3. Domain: add `app.relastack.com`, then add the CNAME record Vercel shows at
   the DNS host (Squarespace).

## How the pieces trust each other

The browser only ever talks to the web tier. Its API calls go to `/api/*` on
`app.relastack.com`, where a route handler relays them to Render with two
headers: `x-internal-secret`, and `x-client-ip` taken from Vercel's own
`x-forwarded-for` (which Vercel overwrites, so a browser cannot forge it).

The API refuses anything without the secret (404, as if the route did not
exist), and only believes `x-client-ip` from a request that had it. That is
what makes per-person rate limiting possible at all: every request arrives
from Vercel's servers, so without it one busy user would throttle everyone.

## When the database sleeps

Neon's free tier suspends after five idle minutes and closes every
connection. The API talks to Postgres through a node-postgres pool, which
closes its own idle connections after 60 seconds and drops any the server
closes the moment it happens, so the next request simply opens a fresh one
and wakes the database.

Prisma's built-in pool cannot do this. It keeps handing out dead connections
and every request fails until the process restarts — measured locally, not
assumed. A Neon restart in the middle of busy traffic can still fail the few
requests in flight at that instant; a reload works.

Background work is prompted rather than polled: an event nudges delivery a
second later, and one hourly sweep catches anything missed. A shorter poll
would keep the database awake and use up the free tier.

## Email

Sent through Resend. relastack.com is verified there by four records at
Squarespace: the `resend._domainkey` TXT (DKIM), the `send` and `rsend`
CNAMEs, and the `_dmarc` TXT. Receiving stays off in Resend: the root MX
points at Gmail, which is where hello@relastack.com lives, and moving it
would stop that inbox receiving anything.

On Render, `EMAIL_PROVIDER=resend` and `EMAIL_API_KEY` (a sending-only key
limited to relastack.com). Without the key the API writes each message to its
log instead of sending it, so nothing is lost, but nothing arrives either.
