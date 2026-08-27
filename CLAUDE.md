# Working agreement

Context for AI assistants and new developers. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
first; this file covers conventions and hard rules.

## What this is

A modular business operating platform sold as SaaS to many independent
businesses. Priced by **business location**, not per user. Organizations
activate modules (CRM, Scheduling, Employees, Inventory, …) at the company
level.

**Current phase: 0 (Project Setup).** No authentication, organizations, or
business modules exist yet. See the phase roadmap below.

## Non-negotiable rules

1. **Tenant isolation is enforced by the backend.** Hiding UI is not access
   control. Every request touching business data is authorized against the
   user's organization.
2. **Cross-tenant access returns 404, never 403.** A 403 confirms the record
   exists, which is itself a leak.
3. **Every schema change ships as a tracked migration.** Never edit a migration
   already applied to a shared environment. Never make a destructive schema
   change without an explicit migration path.
4. **Never read `process.env` outside `packages/config`.** Configuration is
   validated once at startup and injected.
5. **Never hard-code pricing, plan names, or module availability** in business
   logic. Ask the entitlement service.
6. **Every business rule gets an automated test.** Anything touching isolation
   or permissions gets a test that proves the negative case too.
7. **Business logic lives in services, not controllers.** Controllers handle
   transport only.
8. **`packages/*` never import from `apps/*`.** Business modules depend on
   platform services, never directly on one another.
9. **Do not build ahead of the current phase** unless the current phase's
   architecture genuinely requires it.
10. **Prefer configuration and reusable modules** over customer-specific
    branches in core code.

## Conventions

- **Language:** TypeScript, strict mode, everywhere.
- **Naming:** `camelCase` in TypeScript, `snake_case` in SQL, `kebab-case` for
  files. Prisma models are `PascalCase` singular, mapped to `snake_case` plural
  tables.
- **Validation:** Zod at every boundary. Shared contracts live in
  `packages/shared`.
- **Tests:** `*.spec.ts` beside the source for unit tests; `test/*.e2e.spec.ts`
  for end-to-end. Unit tests must not require a database.
- **Comments:** explain _why_, not _what_. Do not narrate the code.
- **Commits:** run `pnpm verify` first.

## Commands

```bash
pnpm setup      # first-time setup, safe to re-run
pnpm dev        # API (:4000) + web (:3000)
pnpm verify     # format + lint + typecheck + unit tests
pnpm test:e2e   # requires pnpm db:up
pnpm db:reset   # DESTROYS local data
```

## Phase roadmap

Each phase ends with a full stop for product-owner approval. Do not begin the
next phase without it.

| Phase | Scope                                                       | Status      |
| ----- | ----------------------------------------------------------- | ----------- |
| 0     | Project setup                                               | **Current** |
| 1     | Authentication, sessions, rate limiting                     |             |
| 2     | Organizations, membership, tenant isolation, RLS            |             |
| 3     | Locations, location membership                              |             |
| 4     | Roles and scoped permissions                                |             |
| 5     | Module registry and entitlement enforcement                 |             |
| 6     | Plans, subscriptions, add-ons                               |             |
| 7     | CRM: leads, customers, contacts, notes, tags, custom fields |             |
| 8     | Tasks and basic workflow infrastructure                     |             |
| 9     | Scheduling                                                  |             |
| 10    | Reporting and dashboards                                    |             |
| 11    | Notifications and the event system                          |             |
| 12    | Automation engine (trigger → condition → action)            |             |
| 13    | Public website API                                          |             |
| 14    | Website module                                              |             |
| 15    | Customer portal                                             |             |
| 16    | Inventory                                                   |             |
| 17    | Custom module framework                                     |             |
| 18    | Payment provider integration                                |             |
| 19    | Internal admin platform                                     |             |
| 20    | Production hardening                                        |             |

## Phase completion checklist

Before reporting a phase complete:

1. Application compiles and runs.
2. Automated tests pass — report real output, never assume.
3. Migrations apply cleanly from an empty database (`pnpm db:reset`).
4. Tenant isolation still holds (from Phase 2 onward).
5. Previously working functionality still works.
6. Known limitations are stated explicitly.
