# ADR 0004 — Integrating with accounting and mail rather than replacing them

- **Status:** Accepted
- **Date:** 2026-08-29
- **Phase:** 8 (implemented from Phase 11 onward)

## Context

The platform runs a business's operations: customers, work, schedules, stock.
Two adjacent systems already exist in every one of those businesses and are not
going anywhere.

**Accounting.** The market is US-only, which settles this: QuickBooks Online is
the default for small business there in a way it is nowhere else, and the
person who insists on it is the accountant rather than the owner. Building
bookkeeping would mean competing with a mature product on a regulated surface —
sales tax, filing formats — for no strategic gain.

**Email.** Correspondence with a customer currently lives in whichever
employee's inbox received it. When that person is away, or leaves, the history
goes with them. Both Microsoft 365 and Google Workspace are in wide use and the
platform must support both; a business does not switch mail provider to suit a
tool.

A concern was raised about competing with an incumbent. Worth recording the
answer plainly: implementing a feature another product also has creates no
legal exposure. Features are not protectable. Risk would come from copying
code, using a trademark, cloning an interface, or breaching terms accepted as a
customer of that product — none of which is in play. This is a commercial
question, not a legal one.

## Decision

**Own operations. Integrate with the systems of record for accounting and
mail.**

| Concern      | Position                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| Bookkeeping  | Never built. Invoices push to QuickBooks; payment status pulls back.       |
| Mail sending | Built. Notifications and documents go out from the platform.               |
| Mail history | Integrated. Messages are read from the provider and shown on the customer. |

The commercial position that follows: the accountant keeps QuickBooks, the
business gets one place to run the work, and the integration becomes a reason
to buy rather than an objection to overcome.

**One connection layer, several adapters.** QuickBooks, Microsoft 365 and
Google Workspace all need the same thing — an OAuth grant held per
organization, refreshed on a schedule, reconnected when it lapses, revocable on
demand. That is built once. Each provider is then a small adapter, the same
shape as the billing provider abstraction.

Building three integrations separately would mean writing that layer three
times and getting the token handling subtly wrong in at least one of them.

## Consequences

**A new and serious security surface.** A QuickBooks refresh token is standing
access to a customer's accounting. A mail token can read their correspondence.
These are the most sensitive things the platform will ever hold — more so than
passwords, which are hashed and cannot be reversed.

They require encryption at rest with a key that is not the database, a
revocation path a customer can trigger themselves, and an audit trail of what
was accessed. None of that exists yet, which is why the connection layer is its
own piece of work rather than a detail inside a feature phase.

**Provider review has a lead time.** Intuit reviews applications before
granting production access, with a security questionnaire. Google verifies
applications requesting restricted mail scopes. Microsoft requires an app
registration and, for some scopes, tenant admin consent. These clocks should be
started well before the code needs them.

**Sequencing.** Invoice sync has nothing to sync until invoicing exists
(Phase 18). Mail logging cannot precede the connection layer. Mail sending
(Phase 11) is a prerequisite for almost everything and comes first.

## Which accounting systems

**QuickBooks Online, integrated properly. Everything else, a CSV export.**

Export is the floor and it covers everyone: a clean file of invoices and
payments that any accountant can import into anything. Nobody is ever blocked
because their bookkeeper uses something unusual. It is cheap, it never breaks,
and it turns the long tail into a non-problem.

Xero is the only plausible second integration — present in the US, and the best
API of the alternatives — but it does not earn the work until there is evidence
of demand. The waitlist can supply that: asking signups what they use for their
books turns this from a guess into a count.

**QuickBooks Desktop is explicitly out of scope.** Still common among
established US businesses and their bookkeepers, and it has no cloud API —
integration means Intuit's Web Connector running on the customer's own machine.
That is a different product with different failure modes, not a variation on
the same one. The trap to watch for: a customer saying "we use QuickBooks"
means either, and which one changes what is possible.

Ruled out for a US-only market: Sage, MYOB and Zoho Books have too little US
presence to earn an adapter. FreshBooks and Wave serve very small operators who
are served well enough by the export.

## Alternatives considered

**Build accounting.** Rejected. A regulated, mature surface, defended by an
incumbent, that no customer is asking to switch.

**Integrate several accounting systems up front.** Rejected for now. The US
market concentrates on one, and the export covers the rest at a fraction of the
cost. The adapter interface stays narrow — customer, invoice, payment status —
so a second provider is a small piece of work whenever evidence justifies it.

**Pick one mail provider.** Rejected. Microsoft and Google are both common
enough that choosing one would exclude roughly half the market, and the second
adapter is cheap once the connection layer exists.

**One-off integrations without a shared layer.** Rejected. Three
implementations of OAuth token refresh is three chances to leak a credential.
