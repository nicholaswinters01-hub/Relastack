# ADR 0002 — Multi-tenancy via shared schema and Row-Level Security

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** 0 (policies implemented in Phase 2)

## Context

Many independent businesses will run on one platform. A single cross-tenant data
leak is not an embarrassment to be patched — for a business platform it is an
existential event, and likely a reportable one.

Isolation must therefore hold even when application code is wrong, because over
a multi-year project, application code will occasionally be wrong.

## Decision

**Shared database, shared schema, `organization_id` discriminator column,
enforced by PostgreSQL Row-Level Security, backed by an automated cross-tenant
test suite that runs on every commit.**

## Rationale

### Why shared schema over the alternatives

| Strategy                | Isolation                                | Migration cost                        | Operational cost               | Verdict    |
| ----------------------- | ---------------------------------------- | ------------------------------------- | ------------------------------ | ---------- |
| Database per tenant     | Strongest                                | Very high                             | Scales linearly with customers | Rejected   |
| Schema per tenant       | Strong                                   | High — one migration across N schemas | Moderate                       | Rejected   |
| **Shared schema + RLS** | **Strong when enforced by the database** | **One migration, always**             | **Low**                        | **Chosen** |

Schema-per-tenant sounds appealing until the first migration must be applied
across two thousand schemas, at which point every deployment becomes a
long-running, partially-failing batch job. Database-per-tenant makes cost and
operational burden scale with customer count, which is precisely backwards for a
business that wants many small customers.

Shared schema keeps migrations singular and predictable. Its weakness — that
isolation depends on getting queries right — is exactly what RLS removes.

### Why RLS is non-negotiable

Application-level filtering fails in one specific, extremely common way: someone
writes a query and forgets the tenant predicate. Code review catches most of
these. "Most" is not an acceptable standard here.

With RLS, the database refuses to return another organization's rows regardless
of what the query says. The application layer becomes a convenience and a
performance optimisation, not the security boundary.

### Defence in depth

| Layer | Mechanism                                     | What it catches                        |
| ----- | --------------------------------------------- | -------------------------------------- |
| 1     | `organization_id` on every tenant-owned table | Makes ownership explicit and indexable |
| 2     | PostgreSQL RLS policies                       | Forgotten predicates, ORM bugs         |
| 3     | Tenant context required by every service call | Code paths that never had a tenant     |
| 4     | Cross-tenant tests in CI                      | Regressions from future work           |

### Cross-tenant responses return 404, never 403

A 403 confirms that a record exists. That is itself a cross-tenant information
leak — an attacker can enumerate identifiers and learn what another organization
owns. Another tenant's data must be indistinguishable from data that does not
exist.

## Implementation notes

Deferred to Phase 2, when the first tenant-owned tables exist:

- Every tenant-owned table carries a non-nullable `organization_id`.
- An RLS policy on each such table compares `organization_id` against a
  per-transaction session variable (`app.current_organization_id`).
- Prisma sets that variable inside the transaction that serves each request.
- The application connects as a role **without** `BYPASSRLS`. Migrations use a
  separate, privileged role.
- The isolation test suite proves that Organization A cannot read, update, or
  delete Organization B's records — through the service layer _and_ through the
  HTTP API.

## Consequences

**Accepted costs**

- Every tenant-scoped query runs inside a transaction that sets the session
  variable, adding minor overhead.
- Two database roles to manage instead of one.
- Developers must understand RLS when debugging "missing" rows.

**Benefits**

- Isolation survives ordinary application bugs.
- One migration path, regardless of customer count.
- Predictable, low operational cost as the business grows.

## Revisit if

A single customer's data volume justifies dedicated infrastructure, or a
customer contractually requires physical isolation. Both are addressed by moving
that one tenant to its own database — the `organization_id` model makes this a
data migration rather than an architectural change.
