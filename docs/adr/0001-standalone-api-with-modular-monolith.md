# ADR 0001 — Standalone API with a modular monolith

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** 0

## Context

The platform must eventually serve the web application, mobile applications,
customer-owned websites (WordPress, custom, third-party), and third-party
integrations. Website-to-CRM traffic is a first-class product flow scheduled for
Phase 13, not a hypothetical.

At the same time, this is a small team building a product that does not yet have
customers. Operational complexity taken on now is complexity paid for daily.

Two questions had to be answered:

1. Should the API be part of the web framework, or standalone?
2. Should the backend be a monolith or a set of services?

## Decision

**A standalone NestJS API (on the Fastify adapter), structured as a modular
monolith, in a pnpm monorepo alongside a Next.js web client.**

## Rationale

### Why a standalone API rather than Next.js route handlers

Next.js route handlers are adequate for a single first-party frontend. They are
a poor foundation for a public product surface: versioning is manual, OpenAPI
generation is awkward, and there is no natural place to run API-key
authentication alongside cookie sessions.

The alternative — start in Next.js and extract later — would require extracting
the API at Phase 13, at which point CRM, Tasks, Scheduling, and Reporting all
depend on it. That is a large refactor at precisely the moment real customers
are onboarding. Building it standalone now is cheaper than extracting it later.

### Why NestJS specifically

NestJS maps unusually well onto this product's requirements:

- Its module system mirrors the product's own module concept, so the code
  structure matches the domain rather than fighting it.
- **Guards** provide a declarative, globally-applied enforcement chain
  (`Auth → Tenant → Permission → Entitlement`). This turns "the developer forgot
  to check the organization" from a likely bug into a structural impossibility.
  Given that tenant isolation is the platform's central promise, this is the
  deciding factor.
- Dependency injection makes services testable without a running server.
- First-class OpenAPI generation, needed for the Phase 13 public API.

The Fastify adapter is used over Express for throughput and because its
`inject()` method allows end-to-end tests without binding a real port.

### Why a modular monolith rather than microservices

There is no scaling problem, no team-coordination problem, and no
independent-deploy requirement. Microservices would buy distributed
transactions, network failure modes, and roughly an order of magnitude more
operational burden, in exchange for nothing currently needed.

The module boundaries and the rule that business logic never imports transport
code mean a module can be extracted into its own service on the day there is an
actual reason to.

## Consequences

**Accepted costs**

- Two processes to run in development (mitigated: `pnpm dev` runs both).
- More initial setup than a single Next.js application.
- Monorepo package builds must precede application start (mitigated: `pnpm setup`).

**Benefits**

- The API is a real product surface from day one — versioned, documented, and
  ready for mobile, customer websites, and integrations with no rework.
- The guard chain gives one enforcement point for every access rule.
- The web app is one client among several, so no privileged path to data can
  quietly develop inside it.

## Alternatives considered

| Option                      | Why rejected                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js only, extract later | Defers a large refactor to the worst possible moment (Phase 13, with customers live)                                                          |
| Fastify without NestJS      | Lighter, but the module system, DI, guard chain, and OpenAPI generation would all be hand-built — reimplementing what NestJS already provides |
| Microservices               | Solves problems the project does not have, at significant ongoing cost                                                                        |
