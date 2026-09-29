# Contracts and e-signature, on the integrations layer: design

Status: **approved 2026-09-28**. **Stage 1 complete** (built, connected to a real DocuSign demo account, and approved 2026-09-28): DocuSign first, then Dropbox Sign; stage 1 (connections) is approved separately from stage 2 (contracts). Takes Phase 11a
off hold for its connection layer, as ADR 0004 intended: "one connection layer,
several adapters".

The idea (product owner, 2026-09-28): a business sends contracts and documents
to its customers to sign. RelaStack is not a file store; the documents live
with the e-signature service the business already uses.

Answers so far:

- **Whatever the business already uses.** DocuSign and Dropbox Sign first,
  each an adapter on one connection layer. More (PandaDoc and others) can
  follow when a customer asks.
- **Each business connects its own account.** Their templates, their branding,
  their signed copies.
- **Contracts on Pro and Business** (and the trial).

## Stage 1: the connection layer (Phase 11a's core)

A business connects an outside account once. RelaStack holds the grant that
lets it act for them. ADR 0004 calls these grants the most sensitive thing the
platform will ever store, more sensitive than passwords.

**Connecting.**

- **Settings → Connected apps → Connect DocuSign.** The owner is sent to
  DocuSign, signs in there, and approves. They are then brought back.
- **The link is tied to them.** The OAuth `state` is a random, single-use
  value, expires after 10 minutes, and is bound to the business and the
  person who started it. The callback refuses anything else. PKCE is used
  where the provider supports it.
- **Who may manage connections:** owners and admins (`organization.write`,
  organization-wide).

**Holding the grant.**

- **Encryption:** tokens are encrypted in the API with AES-256-GCM before they
  reach the database. The key comes from `INTEGRATION_TOKEN_KEY`, read in
  `packages/config` and never kept in the database. Each row carries its key
  version, so the key can be rotated.
- **Bound to its row:** each ciphertext is sealed to its business and provider
  (authenticated data), so a copied row cannot be decrypted as anyone else's.
- **Never exposed:** tokens are never returned by any route, logged, or shown
  to staff.
- **Refreshed when used:** a grant about to expire is refreshed when it is next
  used, under a lock. There is no background refresh job, so the
  platform-worker hatch stays at its three tables.

**Disconnecting.**

- The owner clicks Disconnect. RelaStack asks the provider to revoke the grant
  where it can, and deletes the ciphertext either way.
- If the provider refuses the grant (it was revoked on their side, or has
  lapsed), the connection is marked **Needs reconnecting** and the owner is
  told.

**Audit.** Every connection, refresh, use ("listed templates", "sent document
X"), failure and disconnection is written, append-only, to
`integration_events`: who, when and what for, never the token.

**Adapters.** A provider is a small class behind one interface:

- authorize URL, code exchange, refresh and revoke
- list templates
- send from a template
- get status
- download the signed copy
- void

DocuSign and Dropbox Sign are the first two. Adding a provider means adding one
adapter.

## Stage 2: Contracts (a module, on Pro and Business)

**Sending, from the customer's page.**

- Choose a connected account and one of its templates. The customer's name,
  email, address and account number fill the template's fields.
- Fields the customer record doesn't cover (service, price, start date) are
  typed in.
- On Send, the provider emails the customer and handles the signing.
- **Who may send:** anyone who can edit that customer (`customer.write` at the
  customer's branch).

**What RelaStack keeps.**

- **A contracts row:** customer, provider, the provider's document id, template
  and title, signer, status, who sent it, timestamps, and the values that were
  filled in.
- **Never the document.**
- **Viewing the signed copy** fetches it from the provider through the API on
  demand, after the same visibility check as the customer.

**Status.**

- **Sources:** the provider tells us through its webhook (DocuSign Connect,
  Dropbox Sign callbacks), and a "Check status" button asks directly in case a
  webhook was missed.
- **Checking webhooks:** each one is verified by the provider's signature and
  arrives on a URL with a random per-connection token. That token is resolved
  by one narrow database function, not by giving the webhook route general
  access across businesses.
- **Statuses:** Sent → Viewed → **Signed**, or Declined, Voided, Expired.
- **Notification:** "Signed" and "Declined" go to whoever sent the contract,
  through the outbox, the same as other notifications.

**Where it shows.**

- A **Contracts** section on each customer, with a status badge per contract.
- A contracts list with filters by status.
- A dashboard line: "3 contracts waiting for a signature".

**Visibility** follows the customer. Someone who cannot see the customer
cannot see their contracts, and gets a 404, never a 403.

## Stage 3: service agreements start the visits

- When sending, a contract can carry a **plan**: how often, how long each
  visit is, the start date, the branch, and optionally a crew.
- When it comes back **signed**, the recurring series is created
  automatically, using the same rules as creating one by hand.
- A declined or voided agreement creates nothing.

## What you need to do outside RelaStack (one step at a time, when we get there)

- **DocuSign:** create a developer account and an app (an "integration key").
  Add RelaStack's return address and generate a secret. DocuSign then reviews
  the app before it works with real accounts ("go-live"). Their review needs a
  working integration, so we start it as soon as stage 1 runs against their
  test environment.
- **Dropbox Sign:** create an API app with OAuth and add the return address.
  They also approve apps before production.
- **The encryption key:** generate one on your own computer and put it in
  Render's environment. It is never pasted into chat or saved in the code.

## Tests (every rule, and the negative case)

- **Tokens:** never appear in any response, and are stored only encrypted. A
  row copied to another business cannot be decrypted. The wrong key fails
  loudly rather than returning garbage.
- **OAuth state:**
  - a reused state is refused
  - an expired state is refused
  - another person's state is refused
  - another business's state is refused
- **Connections:** only owners and admins can connect or disconnect.
  Disconnecting deletes the ciphertext. A refused refresh marks the connection
  Needs reconnecting.
- **Webhooks:**
  - a bad signature is refused
  - an unknown token is refused
  - a webhook for one business never touches another's contract
- **Contracts:** follow customer visibility (404 across branches and
  businesses), and are refused when the module is off.
- **Stage 3:** a signed agreement creates the series once, even if the webhook
  arrives twice.
- **Adapters** are tested against recorded provider responses, never live
  services, in CI.

## Open questions for the product owner

1. **Which adapter first?** Recommended: **DocuSign**. It is the most common,
   and its go-live review has the longest lead time, so it should start first.
   Dropbox Sign follows in the same stage.
2. **Are stages 1 and 2 one approval, or two?** Recommended: two. The
   connection layer is worth reviewing on its own, because QuickBooks and mail
   will reuse it.

## Stage 2 as built (2026-09-28)

- **Sending:** from the customer's page, choose a DocuSign template. The signer
  defaults to the customer, and template fields whose labels match the
  customer record are filled in (name, email, phone, address, account
  number). Only the template's own fields are sent.
- **Status:**
  - Webhooks use DocuSign's per-envelope `eventNotification`, so nothing
    needs setting up in the business's DocuSign account.
  - The secret address never needs an HMAC key: its token is the secret, and
    a report only prompts RelaStack to read the status back.
  - "Check status" does the same by hand.
- **Signed copy:** "View signed copy" streams DocuSign's combined PDF, and
  every view is logged in Connected apps' activity.
- **Withdraw** voids the envelope at DocuSign, with a reason.
- **Where it shows:** a Contracts page with status filters, and the Contracts
  section on each customer.
- **Not yet:**
  - Dropbox Sign.
  - A dashboard count of contracts waiting.
  - Stage 3: signed agreements starting recurring visits.
  - DocuSign's go-live review, which needs real envelopes sent in the demo
    environment first.
