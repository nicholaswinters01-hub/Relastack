# Working agreement

Context for AI assistants and new developers. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
first; this file covers conventions and hard rules.

## What this is

A modular business operating platform sold as SaaS to many independent
businesses. Priced by **business location**, not per user. Organizations
activate modules (CRM, Scheduling, Employees, Inventory, …) at the company
level.

**Current phase: 20a in progress (deployment, pulled forward).** Feature work is
paused for market research; the product is being put online so research
participants can use it. See docs/deploy.md. Customers, the work to be done
about them, and the work booked into a day. Entitlement derives from a plan
plus purchased add-ons, and a lapsed subscription narrows the account to
read-only rather than locking it. Business logic still asks only "is this
organization entitled to this module?"

A **job** is a customer, a place, a window and a _crew_ — plural, which is the
structural difference from a task. Times are stored as instants and rendered in
the branch's timezone. Conflicts **warn and can be overridden**: refusing
outright gets worked around by booking the wrong slot, which is worse than the
overlap. Touching windows do not clash, because back-to-back is how a day is
filled.

A **series** produces real job rows over a rolling 90-day horizon, not virtual
occurrences. That is why editing one visit is just editing a job. Touching a
visit individually sets `detachedFromSeries`, and rule changes leave it alone
afterwards; stopping a series releases untouched future visits and keeps
everything already done.

Reports run every count through the SAME visibility filter as the list they
summarise. **An aggregate is still a disclosure** — telling a branch employee
the company has forty customers leaks the size of a book they can see four of.
The dashboard also reports its own scope, so a partial view never reads as a
company total.

Anything worth telling somebody about is written to `domain_events` **in the
same transaction as the change**, by a **transactional outbox**. A dispatcher
drains it on a timer, so a slow mail provider never makes anybody wait to save
a task, and a crash between the change and the message is impossible — either
both happened or neither did. Redelivery is safe: the unique pair on
(event, membership) refuses a duplicate notification, and `emailedAt` refuses a
duplicate email.

The bell is **quiet on purpose**. Only work addressed to a specific person, and
money, produce a notification. A bell that lights up for everything is one
people learn to ignore, and that cannot be undone. Preferences decide
_delivery_, never whether the event is recorded — Phase 12's automation reads
the same stream and must not be muted by somebody's inbox settings.

Background work runs as a **single instance** and needs
`FOR UPDATE SKIP LOCKED` before that changes. The dispatcher and the hourly
sweeps are idempotent, so a second copy would duplicate effort rather than
results.

The **staff console** (`/staff`, Phase 19a) is for the people who run RelaStack.
Staff are rows in `platform_staff`, granted only with SQL as the owner role;
the application role cannot write there. Staff see **account information
only** — businesses, subscriptions, people, locations, modules, invitations —
never what a business keeps about its own customers. That is enforced by the
database: `withStaff()` sets `app.staff`, and per-command policies on exactly
those account tables accept it only when `platform_staff` lists the caller.
Customer, job, task and note tables have no staff policy, so they read as
empty. Staff code never uses `withTenant()` for another business — acting AS a
business would unlock everything it owns. Every look and every change is
written to `staff_audit_events` in the same transaction, changes with a
required reason; the application role has no UPDATE or DELETE there.

**Billing is by hand** (Phase 19b) until Phase 18 connects a payment provider.
Staff record payments in `billing_payments`; a recorded payment is the only
thing that makes a business paying, and in production a business cannot choose
a plan or simulate a payment itself (`BILLING_SIMULATION`, refused in
production). A payment covers a calendar month or year, and the subscription is
**recomputed from the payments** after every change rather than nudged. Paid
time runs out: an `ACTIVE` subscription past `periodEndsAt` is past due, with
grace counted from the end of the paid time. Payments are never edited or
deleted, only voided once — the application role holds UPDATE on the void
columns alone. Credit is an append-only ledger in `billing_credits` whose
balance is always the sum. Every money change locks the business's
subscription row first, so credit cannot be spent twice.

Tasks are part of **core**, not a module: Scheduling and Automation both build
on them, and gating the foundation would gate everything standing on it. A task
hangs off a customer or stands alone, and Phase 9 jobs attach through a second
nullable reference rather than a parallel table.

Two task rules that are easy to get wrong. Whoever a task is **assigned to** can
see it wherever it sits and may always move its status, whatever their role —
authority from the row, not the role, and narrowed to the status alone. And a
task **never reveals a customer the reader may not see**: visibility of the task
says nothing about visibility of the customer it concerns.

A lead and a customer are **one record at different stages**, never two tables.
Converting is a status change, so notes, contacts and tags survive it and
nothing is copied. Customers carry a nullable primary `locationId`; Shared
Customers (an Enterprise module) adds extra locations through
`customer_locations`. Visibility is a three-way OR — organization-wide,
primary location in scope, or shared location in scope — and a customer with
no location is reachable only organization-wide.

Three bands, not on/off: `TRIALING`/`ACTIVE`/`PAST_DUE` keep full access,
`SUSPENDED`/`CANCELLED` are read-only. `PAST_DUE` is the grace period and is
deliberately _full_ access — a failed card must not lock a business out
mid-job. Access never becomes nothing: a customer who cannot reach their data
has no reason to come back.

## Non-negotiable rules

1. **Tenant isolation is enforced by the backend.** Hiding UI is not access
   control. Every request touching business data is authorized against the
   user's organization.
2. **Cross-tenant access returns 404, never 403.** A 403 confirms the record
   exists, which is itself a leak. The same applies within an organization
   wherever existence is sensitive — an unassigned location, for instance.
3. **Never query tenant data outside `withTenant()`.** It is the only place
   that establishes database tenant context. Queries run without it see
   nothing, because RLS policies fail closed.
4. **Every schema change ships as a tracked migration.** Never edit a migration
   already applied to a shared environment. Never make a destructive schema
   change without an explicit migration path.
5. **Never read `process.env` outside `packages/config`.** Configuration is
   validated once at startup and injected.
6. **Never hard-code pricing, plan names, or module availability** in business
   logic. Ask the entitlement service.
7. **Permissions are never a plain boolean.** Ask `has()` for organization-wide
   authority and `hasAt(permission, locationId)` for scoped authority. Choosing
   the wrong one either locks scoped users out or grants company-wide power.
8. **Every business rule gets an automated test.** Anything touching isolation
   or permissions gets a test that proves the negative case too.
9. **Business logic lives in services, not controllers.** Controllers handle
   transport only.
10. **`packages/*` never import from `apps/*`.** Business modules depend on
    platform services, never directly on one another.
11. **Do not build ahead of the current phase** unless the current phase's
    architecture genuinely requires it.
12. **Prefer configuration and reusable modules** over customer-specific
    branches in core code.
13. **A lapsed subscription is read-only, never locked out.** Reads always
    work. `@AllowsWhenReadOnly` belongs on billing endpoints and nowhere else
    — a customer must always be able to pay their way out.

## Conventions

- **Language:** TypeScript, strict mode, everywhere.
- **Naming:** `camelCase` in TypeScript, `snake_case` in SQL, `kebab-case` for
  files. Prisma models are `PascalCase` singular, mapped to `snake_case` plural
  tables — every camelCase field needs an explicit `@map`.
- **Validation:** Zod at every boundary. Shared contracts live in
  `packages/shared`. Attach pipes to the `@Body()` PARAMETER, never with
  `@UsePipes` — that applies to every parameter, including custom decorators.
- **Tests:** `*.spec.ts` beside the source for unit tests; `test/*.e2e.spec.ts`
  for end-to-end. Unit tests must not require a database. Test fixtures needing
  cross-tenant setup use `createPrivilegedTestClient()`, never `PrismaService`.
- **Comments:** explain _why_, not _what_. Do not narrate the code.
- **Commits:** run `pnpm verify` first.

## Traps this codebase has already hit

Recorded because each one cost real time and none is obvious.

- **PostgreSQL aborts the whole transaction on any error.** Catching a
  unique-violation and continuing inside a transaction does not work. Use
  `upsert` rather than create-and-catch.
- **Superusers bypass RLS unconditionally.** The app connects as
  `platform_app`; the migration role would leave every policy inert.
- **Object spread overwrites earlier keys.** `{ id, ...filter }` where the
  filter also has `id` silently discards the requested id. Use `AND: [...]`.
- **ES module imports are hoisted above all statements.** Setting
  `process.env` at the top of a test file happens AFTER any module-scope
  config read in an imported module.
- **`overrideGuard` does not reach guards registered via `APP_GUARD`.**
- **Bash heredocs break on apostrophes in prose.** Several file writes failed
  this way; use the file-write tool for content containing them.
- **Asserting a flag is not asserting enforcement.** A test that checks
  `entitled: false` came back in a list passes just as happily when the guard
  is gone. Deleting the plan check broke exactly one test until a test was
  added that CALLS the gated endpoint and expects 403. Gate tests hit routes.
- **Guards run before validation.** A request refused by `ReadOnlyGuard`
  returns 403 whatever the body contains, so an invalid payload in a test can
  look like it proved enforcement. Use a payload that would otherwise succeed.
- **Migrations can be checked from empty without `db:reset`.** Create a
  throwaway database and point `DATABASE_URL` at it for one
  `prisma migrate deploy`. No reason to destroy local data to prove this.
- **`has()` where `hasAnywhere()` belongs locks scoped users out entirely.**
  A Location Manager holds `customer.read` only at their branches, so an
  organization-wide `has()` refuses them before the visibility filter ever
  runs. Rule 7 exists because of this; it was still got backwards in Phase 7.
  Reads use `hasAnywhere` and let the filter narrow; writes use `hasAt`.
- **A PATCH of a JSONB column replaces it.** Sending one custom field wiped
  every other field on the record. Merge existing values with incoming ones
  INSIDE the transaction, then validate the merged result — validating only
  the incoming keys makes a required field mean "this request mentioned it"
  rather than "the record has it".
- **Prisma drops hand-written SQL objects it does not model.** The Phase 8
  migration was generated with two `DROP INDEX` lines in it, silently removing
  the trigram indexes Phase 7 added by hand. Read every generated migration
  before applying it, and delete drops you did not ask for.
- **A trigger that re-validates unchanged columns breaks cascades.** A task
  references a membership twice; deleting a person nulls both columns as two
  separate updates, so while one is being nulled the other still points at a
  row that has gone. Validate only what changed:
  `TG_OP = 'INSERT' OR NEW.x IS DISTINCT FROM OLD.x`.
- **A Zod `.default()` makes a field present on every parsed body.** The rule
  "an assignee may change only the status" counted keys in the payload, and
  `acknowledgeConflicts` defaults to false — so the count never reached one and
  the crew could never complete their own job. The rule was dead on arrival and
  only a test caught it. Count the fields being CHANGED, listing control flags
  explicitly so the next one has to be considered.
- **A test cleanup that filters on mutable data does not run after a failure.**
  A suite deleting `WHERE name LIKE 'X%'` leaked an organization once a
  sabotage let a rename through. Fixtures should rename within the prefix the
  cleanup matches.
- **RLS fails closed, so background work sees nothing at all.** A worker
  serving every tenant has no single organization to set, and querying the bare
  client returned an empty queue forever — silently, because an empty outbox
  looks exactly like an idle one. `withPlatformWorker()` is the narrow hatch:
  it sets `app.platform_worker` and the policies on **exactly three** tables
  (`domain_events`, `subscriptions`, `job_series`) accept it. Nothing that
  names a person is reachable through it. Every write still goes through
  `withTenant()` for one organization at a time. Do not widen it — a fourth
  table is a design decision, not a convenience.
- **A stored preference for a type nobody reads is worse than an error.** The
  preferences list is built from the catalogue, so a row for a mistyped type
  would never be looked at: somebody would believe they had switched something
  off and keep being told about it. Validate the key against the catalogue.
- **Hosted Postgres never gives you a superuser.** Neon, RDS and Render all
  refuse `ALTER ROLE ... NOSUPERUSER` from their owner role, so a migration
  that works locally can fail on the first production deploy. Check new
  migrations by running them as a non-superuser owner in a throwaway database
  (`CREATE ROLE x LOGIN CREATEROLE BYPASSRLS`, `CREATE DATABASE ... OWNER x`).
  The RLS migration was edited for this after being applied, with the product
  owner's approval, before it had ever run on a shared database. That is the
  only exception to rule 4; a local database needs its `_prisma_migrations`
  checksum updated to match (SHA-256 of the file).
- **Prisma's own pool never recovers from connections the server closed.**
  After Neon sleeps, or any restart, every query failed until the process
  restarted: 40 of 40, then 10 of 10 five seconds later. Resetting it from
  outside was worse: under concurrent load the engine stayed "not yet
  connected" for good. `createPrismaClient` therefore runs Prisma over a
  node-postgres pool (`@prisma/adapter-pg`), which drops a closed connection
  the moment it closes. Do not go back; the delivery e2e suite fails if you do.
- **The pg adapter cannot read Postgres-internal column types in raw
  queries** (`name`, `oid`, `void`). Cast them: `relname::text AS relname`.
- **Behind the web tier, every request comes from the same few addresses.**
  Rate limits keyed on the socket address lump everyone together.
  `trustProxy: true` is worse: anyone can then choose their own address. The
  API believes the web tier's `x-client-ip` only when `x-internal-secret`
  matches. Use `clientIpOf(request)`, never `request.ip`.
- **Tailwind v4 flattens `@theme`, whatever it is nested in.** A second
  `@theme` inside `@media (prefers-color-scheme: dark)` does not apply only in
  dark mode — it wins for everyone. Override the custom properties on `:root`
  inside the media query instead. Both apps shipped with this bug.
- **`NODE_ENV=production` during a build makes pnpm skip dev dependencies.**
  Builds need them (Prisma, TypeScript, the Nest CLI). Hosts that set it for
  the build too need `pnpm install --prod=false`.
- **A staff policy on a customer-data table breaks the staff console's
  promise.** Staff see account information only, and the only thing keeping
  it that way is that `customers`, `jobs`, `tasks`, `customer_notes` and the
  rest have no `*_staff_*` policy. Adding one is a product decision, not a
  convenience; the staff e2e suite fails if staff can read a customer.
- **A refusal test must reach the case the rule exists for.** "Staff cannot
  give a business that has paid a trial" was tested on a business that was
  still paying, which an older rule already refused, so deleting the new rule
  broke nothing. The rule is for a payer whose paid time has lapsed. Break
  each guard once and watch its test fail.
- **Backticks inside `node -e "..."` run as shell commands.** Bash expands them
  before Node sees the script. Several edits to prose came out garbled this
  way, and one silently executed a pnpm command. Use the Edit/Write tools for
  anything containing backticks.

## Commands

```bash
pnpm setup      # first-time setup, safe to re-run
pnpm dev        # API (:4000) + web (:3000)
pnpm verify     # build + format + lint + typecheck + licences + unit tests
pnpm test:e2e   # requires pnpm db:up
pnpm db:reset   # DESTROYS local data
```

## Phase roadmap

Each phase ends with a full stop for product-owner approval. Do not begin the
next phase without it.

| Phase | Scope                                                        | Status   |
| ----- | ------------------------------------------------------------ | -------- |
| 0     | Project setup                                                | Complete |
| 1     | Authentication, sessions, rate limiting                      | Complete |
| 2     | Organizations, membership, tenant isolation, RLS             | Complete |
| 3     | Locations, location membership                               | Complete |
| 4     | Roles and scoped permissions                                 | Complete |
| 5     | Module registry and entitlement enforcement                  | Complete |
| 6     | Plans, subscriptions, add-ons                                | Complete |
| 7     | CRM: leads, customers, contacts, notes, tags, custom fields  | Complete |
| 8     | Tasks and basic workflow infrastructure                      | Complete |
| 9     | Scheduling: jobs, crews, conflicts                           | Complete |
| 9b    | Recurring jobs                                               | Complete |
| 10    | Reporting and dashboards                                     | Complete |
| 11    | Notifications and the event system                           | Complete |
| 11a   | Integrations layer: OAuth vault, QuickBooks, mail providers  | Held     |
| 12    | Automation engine (trigger → condition → action)             |          |
| 13    | Public website API                                           |          |
| 14    | Website module                                               |          |
| 15    | Customer portal                                              |          |
| 16    | Inventory                                                    |          |
| 17    | Custom module framework                                      |          |
| 18    | Payment provider integration, invoice sync to QuickBooks     |          |
| 19a   | Staff console: businesses, support actions, audit trail      | Complete |
| 19b   | Billing by hand: annual plans, payments, credits             | Complete |
| 19c   | Help desk: in-app requests and replies (needs email)         |          |
| 20a   | Deployment: Render + Neon + Vercel, invite-only (pulled fwd) | **Now**  |
| 20    | Production hardening                                         |          |

Accounting and mail are **integrated, never rebuilt** (docs/adr/0004).
QuickBooks keeps the books; invoices push to it from Phase 18. Mail sending
arrives with Phase 11; reading a customer history back from Microsoft 365 and
Google Workspace comes with the integrations layer. Both mail providers are
required — choosing one would exclude half the market.

OAuth grants held on a customer's behalf are the most sensitive data the
platform will ever store, more so than passwords, which are hashed and cannot
be reversed. They are encrypted at rest, revocable by the customer, and audited.

## Phase completion checklist

Before reporting a phase complete:

1. Application compiles and runs.
2. Automated tests pass — report real output, never assume.
3. Migrations apply cleanly from an empty database.
4. Tenant isolation still holds (from Phase 2 onward).
5. Previously working functionality still works.
6. Known limitations are stated explicitly.
