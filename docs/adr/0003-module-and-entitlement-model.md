# ADR 0003 — Separating modules, plans, subscriptions, and entitlements

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** 0 (implemented in Phases 5–6)

## Context

The platform is sold as a base subscription priced by **business location**,
plus company-level module activation. Pricing will change — repeatedly. Plans
will be repackaged, modules will move between "included" and "add-on", trials
and grandfathered pricing will appear.

If pricing concepts leak into business logic, every commercial experiment
becomes an engineering project. The CRM module must never contain a line
resembling `if (plan === 'business')`.

There is also a security requirement: a disabled module must be genuinely
inaccessible. Hiding a navigation item is not access control — a user who reads
the network tab and calls the endpoint directly must be refused.

## Decision

**Four separate concepts, with application code depending only on the last one.**

| Concept          | Owns                                       | Example                                                     |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------- |
| **Module**       | A software capability                      | `crm`, `scheduling`, `inventory`                            |
| **Plan**         | A commercial package                       | "Business" — includes CRM, Scheduling, Employees, Reporting |
| **Subscription** | What one organization currently pays for   | ABC Landscaping, Business plan, 3 locations, active         |
| **Entitlement**  | The resolved right to use a capability now | `may(org, 'inventory')` → true                              |

Business logic asks exactly one question: **is this organization entitled to
this module right now?** It never inspects plans, prices, or billing status.

## Rationale

### Why entitlement is a separate, resolved concept

Entitlement is the single point where commercial rules collapse into a boolean.
It accounts for the plan's included modules, purchased add-ons, trial state,
and payment status — and exposes none of that to callers.

The payoff: introducing a new plan, moving a module from add-on to included, or
defining what happens to access after a failed payment are all changes in _one_
place. No module is edited.

### Why modules activate at the company level

The pricing model attaches to locations, not to modules. When an organization
enables Scheduling, every location gets Scheduling. Modelling per-location
module activation would add a dimension the business does not sell, and every
future query would carry that complexity for no revenue.

### Why entitlement is enforced in the API, not the UI

Navigation hiding is a usability feature. It is not security. A guard on every
module's endpoints means the check happens where it cannot be bypassed.

Note the separation this creates: **whether a module is compiled into the
deployed build is entirely unrelated to whether a customer may use it.** Every
organization runs the same binary; entitlement is resolved per request.

### Why pricing is data, never code

Prices, plan compositions, and add-on availability live in database tables. The
application reads them. Rule 9 of the project charter — do not hard-code
subscription pricing — is enforced structurally rather than by convention.

## Implementation notes

- **Phase 5** — module registry, per-organization module records, dependency
  resolution, and the `EntitlementGuard`. Backed by a mock entitlement source so
  that module enforcement can be built and tested before billing exists.
- **Phase 6** — plans, subscriptions, add-ons, and location entitlement replace
  the mock source. No module code changes, which is the test of whether this
  separation actually worked.
- **Phase 18** — a real payment provider syncs into subscription state. Payment
  failure affects entitlement through explicitly defined business rules, in one
  place.

A module declares its own metadata (key, name, version, dependencies,
configuration schema, permissions, navigation entries). Adding a module must not
require editing core platform code — that is the property that lets the platform
grow more capable as customers are added.

## Consequences

**Accepted costs**

- More tables and more indirection than storing a plan name on the organization.
- Entitlement resolution must be cached to avoid a lookup per request.
- Module dependencies need resolution (enabling Scheduling may require CRM).

**Benefits**

- Pricing changes without code changes.
- Disabled modules are unreachable, not merely hidden.
- New modules ship without touching the core.
- Billing integration is deferred safely, because entitlement already exists as
  an abstraction with a mock implementation behind it.

## Alternatives considered

| Option                                               | Why rejected                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Plan name stored on the organization, checked inline | Every pricing change becomes a code change across every module                                  |
| Per-location module activation                       | Adds a dimension the business does not sell                                                     |
| Feature flags as entitlements                        | Flags are for rollout, not commercial rights; conflating them makes both harder to reason about |
