# Architecture

How the platform fits together, and why. Decisions with meaningful trade-offs
are recorded separately as [ADRs](./adr/).

---

## 1. What we are building

A reusable software foundation that many independent businesses run on
simultaneously. Each customer organization activates the modules it needs and
configures them to its industry, while the underlying platform stays the same.

The commercial model shapes the architecture directly:

- **Priced by location, not by user.** An organization with 3 locations and 400
  employees pays for 3 locations. The data model must never make user count a
  billing input, and no vendor we depend on may price per user.
- **Modules activate at the company level.** When an organization enables
  Scheduling, all of its locations get Scheduling.
- **One platform, many configurations.** Customer-specific behaviour comes from
  configuration and reusable modules — never from forked core code.

---

## 2. Shape of the system

```
                          ┌──────────────────────┐
   Browser  ──────────────│  apps/web            │
                          │  Next.js             │
                          └──────────┬───────────┘
                                     │
   Customer websites  ───────┐       │  HTTPS
   Mobile apps        ───────┼───────┤
   Integrations       ───────┘       │
                                     ▼
                          ┌──────────────────────┐
                          │  apps/api            │
                          │  NestJS + Fastify    │
                          │                      │
                          │  Guard chain:        │
                          │   Auth               │
                          │   → Tenant           │
                          │   → Permission       │
                          │   → Entitlement      │
                          └──────────┬───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │  PostgreSQL          │
                          │  + Row-Level Security│
                          └──────────────────────┘
```

The API is the **only** path to business data. The web app holds no privileged
database access of its own; it is one API client among several. That is what
allows customer websites, mobile apps, and third-party integrations to be added
later without re-plumbing anything.

---

## 3. The hierarchy

```
Platform
  └── Organization        the tenant boundary — the unit of isolation
        ├── Locations     the unit of billing
        ├── Users         organization-wide identities
        │     └── Roles   scoped to the whole org, or to specific locations
        └── Business data always carries organization_id
```

A user may hold access to one location, several, or the entire organization.
That is why a permission is never a plain yes/no — it is a permission **plus a
scope**. See section 5.

---

## 4. Multi-tenancy

Shared database, shared schema, `organization_id` discriminator, enforced by
PostgreSQL Row-Level Security. See [ADR 0002](./adr/0002-multi-tenancy-strategy.md).

Isolation is defended in four independent layers, because any single layer will
eventually be defeated by an ordinary human mistake:

| Layer | Mechanism                                     | Catches                                    |
| ----- | --------------------------------------------- | ------------------------------------------ |
| 1     | `organization_id` on every tenant-owned table | Makes ownership explicit and indexable     |
| 2     | **PostgreSQL RLS**                            | A forgotten WHERE clause or an ORM bug     |
| 3     | Tenant context required by every service call | Code that never had a tenant to begin with |
| 4     | Automated cross-tenant tests in CI            | Regressions introduced by future work      |

Layer 2 is the one that matters most: it means a mistake in application code
still cannot return another organization's rows, because the database itself
refuses.

---

## 5. Authorization

Independent questions are answered on every request that touches business data.
They are separate concerns and are never collapsed into one check:

| Question                                      | Enforced by        | Failure                     |
| --------------------------------------------- | ------------------ | --------------------------- |
| Who are you?                                  | `AuthGuard`        | 401                         |
| Which organization's data is this?            | `TenantGuard`      | 404 (never 403 — see below) |
| Are you allowed to do this, here?             | `PermissionGuard`  | 403                         |
| Is this organization entitled to this module? | `EntitlementGuard` | 402 / 404                   |

**Cross-tenant requests return 404, not 403.** A 403 confirms the record exists,
which leaks information across a tenant boundary. To an outsider, another
organization's data must be indistinguishable from data that does not exist.

Permissions carry a **scope**, because a Location Manager manages _specific_
locations:

```
permission: customer.write
scope:      location
locations:  [Downtown, Northside]
```

Every check therefore answers _who, what, and where_.

---

## 6. Modules and entitlements

Four concepts, deliberately kept separate so that pricing can change without
touching business logic ([ADR 0003](./adr/0003-module-and-entitlement-model.md)):

| Concept          | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| **Module**       | A capability of the software (CRM, Scheduling, Inventory)                 |
| **Plan**         | A commercial package that includes certain modules                        |
| **Subscription** | What a specific organization currently pays for                           |
| **Entitlement**  | The resolved answer to "may this organization use this module right now?" |

Application code only ever asks about **entitlement**. It never inspects plans
or prices. This is what allows plans to be repackaged, add-ons introduced, and
pricing restructured without editing a single module.

Critically: **a module being present in the deployed build is unrelated to
whether a customer may use it.** Every module's endpoints are guarded, so
calling an endpoint of a disabled module directly — bypassing the UI entirely —
fails at the API.

---

## 7. Configuration

All environment configuration is validated once, at startup, by
`@platform/config`. Application code receives a fully typed object and never
reads `process.env` directly.

A missing or malformed variable crashes the process immediately with a message
naming every problem found. The alternative — an `undefined` that surfaces three
layers deep during a customer request — is far more expensive to diagnose.

---

## 8. Project layout

```
apps/
  api/                    NestJS API
    src/
      config.provider.ts  Validated config, as an injectable
      prisma/             Database client lifecycle
      health/             Health and liveness endpoints
      app.module.ts       Composition root
      main.ts             Bootstrap
  web/                    Next.js web application

packages/
  config/                 Environment schema and validation
  db/                     Prisma schema, migrations, client factory
  shared/                 API contracts used by server and client alike
```

**Dependency rule:** `apps/*` may depend on `packages/*`. `packages/*` never
depend on `apps/*`. Business modules depend on platform services, never on one
another directly — when Scheduling needs a customer, it goes through a defined
CRM interface rather than reaching into CRM's tables.

---

## 9. Testing

| Layer      | Tool                    | Requires a database | Purpose                                                   |
| ---------- | ----------------------- | ------------------- | --------------------------------------------------------- |
| Unit       | Vitest                  | No                  | Logic in isolation                                        |
| End-to-end | Vitest + Fastify inject | Yes                 | The real app over real HTTP                               |
| Isolation  | Vitest                  | Yes                 | _Proof_ that tenants cannot see each other (from Phase 2) |

The isolation suite is not a formality. It is the test that protects the
central promise of the product, and it runs on every commit forever.

---

## 10. Deliberately deferred

Recorded so that their absence is understood as a decision rather than an
oversight:

| Concern                     | Arrives in | Why not now                             |
| --------------------------- | ---------- | --------------------------------------- |
| Authentication              | Phase 1    | Nothing to protect yet                  |
| Row-Level Security policies | Phase 2    | Requires tenant-owned tables to exist   |
| Rate limiting               | Phase 1    | Belongs with the first public endpoints |
| Structured request logging  | Phase 11   | Belongs with the event system           |
| Production container build  | Phase 20   | Deployment topology is not yet decided  |
| Payment provider            | Phase 18   | Internal billing must be stable first   |
