# Working agreement

Context for AI assistants and new developers. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
first; this file covers conventions and hard rules.

## What this is

A modular business operating platform sold as SaaS to many independent
businesses. Priced by **business location**, not per user. Organizations
activate modules (CRM, Scheduling, Employees, Inventory, …) at the company
level.

**Current phase: 5 complete (Modules and entitlements).** A module registry
with per-organization entitlements. Business logic asks only "is this
organization entitled to this module?" — never about plans or prices, so
Phase 6 can introduce those behind the same interface without touching a
module. Custom Roles is the first gated capability. No business data yet.

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

| Phase | Scope                                                       | Status   |
| ----- | ----------------------------------------------------------- | -------- |
| 0     | Project setup                                               | Complete |
| 1     | Authentication, sessions, rate limiting                     | Complete |
| 2     | Organizations, membership, tenant isolation, RLS            | Complete |
| 3     | Locations, location membership                              | Complete |
| 4     | Roles and scoped permissions                                | Complete |
| 5     | Module registry and entitlement enforcement                 | Complete |
| 6     | Plans, subscriptions, add-ons                               | **Next** |
| 7     | CRM: leads, customers, contacts, notes, tags, custom fields |          |
| 8     | Tasks and basic workflow infrastructure                     |          |
| 9     | Scheduling                                                  |          |
| 10    | Reporting and dashboards                                    |          |
| 11    | Notifications and the event system                          |          |
| 12    | Automation engine (trigger → condition → action)            |          |
| 13    | Public website API                                          |          |
| 14    | Website module                                              |          |
| 15    | Customer portal                                             |          |
| 16    | Inventory                                                   |          |
| 17    | Custom module framework                                     |          |
| 18    | Payment provider integration                                |          |
| 19    | Internal admin platform                                     |          |
| 20    | Production hardening                                        |          |

## Phase completion checklist

Before reporting a phase complete:

1. Application compiles and runs.
2. Automated tests pass — report real output, never assume.
3. Migrations apply cleanly from an empty database.
4. Tenant isolation still holds (from Phase 2 onward).
5. Previously working functionality still works.
6. Known limitations are stated explicitly.
