# Platform

A modular business operating platform for small and growing businesses.

Customer organizations activate the modules they need (CRM, Scheduling,
Employees, Inventory, and more), configure workflows and custom fields, and
connect their public website directly to the platform. Sold as a recurring SaaS
subscription priced primarily by **business location**, not by employee.

> **Status: Phase 0 — Project Setup.** The foundation is in place: repository,
> monorepo structure, configuration management, database connection, testing,
> and linting. No authentication, organizations, or business modules exist yet.

---

## Prerequisites

| Tool           | Version                     | Install                               |
| -------------- | --------------------------- | ------------------------------------- |
| Node.js        | 20.11+ (24 LTS recommended) | `winget install OpenJS.NodeJS.LTS`    |
| pnpm           | 10.x                        | `npm install -g pnpm@10`              |
| Docker Desktop | any recent                  | `winget install Docker.DockerDesktop` |
| Git            | 2.40+                       | `winget install Git.Git`              |

> **Windows note:** Docker Desktop requires WSL2. If Docker reports
> "Virtualization support not detected", the cause is usually that WSL is not
> installed rather than a BIOS setting. Run `wsl --install --no-distribution`
> in an **Administrator** PowerShell, reboot, then start Docker Desktop.

---

## Quick start

```bash
pnpm setup     # install deps, start PostgreSQL, generate client, migrate, build
pnpm dev       # start the API (:4000) and the web app (:3000)
```

Then open <http://localhost:3000>. All three status rows should read green.

`pnpm setup` is safe to re-run at any time.

---

## Commands

### Everyday

| Command        | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `pnpm dev`     | Run API and web together with hot reload                             |
| `pnpm dev:api` | API only, on port 4000                                               |
| `pnpm dev:web` | Web only, on port 3000                                               |
| `pnpm verify`  | Format check + lint + typecheck + unit tests (run before committing) |

### Database

| Command            | What it does                                       |
| ------------------ | -------------------------------------------------- |
| `pnpm db:up`       | Start PostgreSQL in Docker                         |
| `pnpm db:down`     | Stop it, preserving data                           |
| `pnpm db:reset`    | **Destroy all local data** and start fresh         |
| `pnpm db:migrate`  | Apply pending migrations                           |
| `pnpm db:generate` | Regenerate the Prisma client after a schema change |
| `pnpm db:studio`   | Browse the database in a GUI                       |

### Testing

| Command         | What it does                                       |
| --------------- | -------------------------------------------------- |
| `pnpm test`     | Unit tests. Fast, no database required.            |
| `pnpm test:e2e` | End-to-end tests. **Requires `pnpm db:up` first.** |

---

## Project layout

```
apps/
  api/          NestJS API — the only path to business data
  web/          Next.js web application
packages/
  config/       Validated, typed environment configuration
  db/           Prisma schema, migrations, client factory
  shared/       API contracts shared by server and client
docs/
  ARCHITECTURE.md   How the system fits together
  adr/              Architecture Decision Records — why things are the way they are
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

---

## Verifying Phase 0

```bash
curl http://localhost:4000/api/v1/health
```

A healthy response reports `"status": "ok"` and
`"dependencies": { "database": { "status": "connected", ... } }`.

---

## Development rules

These are not stylistic preferences. They are the constraints that keep the
platform safe to sell to many businesses at once.

1. **Every schema change ships as a tracked migration.** Never edit a migration
   that has already been applied to a shared environment.
2. **Tenant isolation is enforced by the backend, never by the UI.** Hiding a
   button is not access control.
3. **Never read `process.env` outside `packages/config`.** Configuration is
   validated once, at startup.
4. **Business logic does not live in controllers.** Controllers handle
   transport; services own the rules.
5. **Every business rule gets an automated test.**
6. **Run `pnpm verify` before every commit.**
