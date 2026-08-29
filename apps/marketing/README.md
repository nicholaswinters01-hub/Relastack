# BizFoundry — marketing site

The public landing page and waitlist. Deliberately **not** part of `apps/web`.

`apps/web` is the signed-in product: it runs the auth middleware, the
nonce-based CSP and the tenant guard on every request, and redirects to
`/login` without a session. A marketing page needs the opposite — anonymous,
cacheable, indexable, and up when the API is down. It shares the design tokens
and the workspace tooling, and nothing else. It does not talk to the product
API at all.

```bash
pnpm dev:marketing    # http://localhost:3001
```

## Before this goes live

1. **Add the logo file** at `public/logo.png`. The header uses a text
   wordmark by design — crisp at any size, correct in dark mode, never a
   broken image — but the favicon and the social card need the raster.
2. **Revisit `legalEntity` in `src/lib/brand.ts` when the LLC is formed.**
   It currently names an individual, which is correct while trading as one.
   The privacy notice must name whoever actually holds the data at the time.
3. **Have the privacy notice reviewed.** It accurately describes what the form
   does, which is the necessary starting point, but it has not been read by a
   lawyer.
4. **Check the pricing claims.** The page states the model — per location,
   users free — and no figures. If figures are added, they become a promise.

## Colour

`--color-accent` is the logo orange. It measures 2.76:1 on white, which is
fine for a mark and fails WCAG AA for anything read as text. Use
`--color-accent-ink` (4.76:1 on the canvas, 5.06:1 behind white button text)
wherever the orange has to carry words.

## Where the list can go

`postgres` is the current destination — see **Where signups are stored** below.
The email services stay wired up for when there is a list worth mailing, since
nothing in the platform can send email until Phase 11.

```bash
WAITLIST_PROVIDER=postgres     # or buttondown | convertkit | resend | log
WAITLIST_API_KEY=...           # the email services only; secret, server-side
WAITLIST_LIST_ID=...           # ConvertKit form id / Resend audience id
```

With no configuration at all the provider is `log`: the form works end to end
and writes the signup to the server log. That makes local development possible
without an account, and means a misconfigured deploy loses the signup rather
than showing a visitor an error.

Adding a provider is one object in `src/lib/waitlist-provider.ts`. Every
vendor quirk is behind that interface, for the same reason the working
agreement keeps payment-provider logic behind one — whichever service is picked
today is almost certainly not the one sending mail in two years.

### Double opt-in

Buttondown and ConvertKit send the confirmation themselves; the Buttondown
adapter creates subscribers as `unactivated` so they are only added once they
click. **Resend audiences do not** — choosing Resend means building the
confirmation step before launch, or the list is single opt-in.

## What the form does

- Requires an explicit, unticked-by-default consent box, and records when it
  was ticked. Consent cannot be obtained retroactively; a list built without it
  has to be re-permissioned from scratch.
- Carries a honeypot field, and answers a bot with the same success message as
  anyone else.
- Rate limits per IP in memory — enough for someone hammering the form, and not
  worth real infrastructure for a landing page.
- Returns **one** message whether the address is new or already subscribed.
  Distinguishing them would turn the form into an oracle for checking whether a
  given address had signed up.

## Why the CSP lives in middleware

A flat `script-src 'self'` in `next.config.mjs` blocks the inline bootstrap
Next.js emits, so React never hydrates. The markup still renders perfectly,
which makes it easy to miss — the console is the only sign. That happened
during the build of this app and was caught only by checking browser errors.

The policy therefore carries a per-request nonce and `strict-dynamic`, exactly
as `apps/web` does.

## Progressive enhancement

The form posts natively when JavaScript is unavailable: `method="post"` to the
same route, which answers a form-encoded body with a 303 to `/thanks`. With
JavaScript it swaps itself for a confirmation in place and never navigates.

Both paths matter. The native `method="post"` in particular is what stops a
browser falling back to GET and putting the visitor's email address in the URL,
where every proxy and access log in the path would record it.

## Where signups are stored

A Postgres table you own, not a mailing-list vendor. Set:

```bash
WAITLIST_PROVIDER=postgres
DATABASE_URL=postgresql://user:pass@host/db
```

The table is created on first use — there is no migration to run. One table
that is never altered does not need the ceremony, and the product's own schema
keeps its migrations separately.

```
waitlist_signups
  id            uuid
  email         text, unique
  note          text        -- the "what do you do?" answer
  source        text        -- 'waitlist'
  consented_at  timestamptz -- when the box was ticked
  created_at    timestamptz
```

TLS is negotiated based on the connection string: on unless `sslmode=disable`
is set or the host is loopback. A Postgres in a local container usually offers
no certificate at all and refuses the handshake, so hard-coding it on makes the
thing untestable locally.

### Turning these into real customers later

The columns are shaped like a CRM lead on purpose. Once the product is
deployed, they import in one statement rather than by hand:

```sql
INSERT INTO customers (id, organization_id, display_name, email, source, stage, type, created_at, updated_at)
SELECT
  gen_random_uuid(),
  '<your-organization-id>',
  w.email,          -- no name was collected, so the address stands in
  w.email,
  'Waitlist',
  'LEAD',
  'PERSON',
  w.created_at,
  now()
FROM waitlist_signups w
ON CONFLICT DO NOTHING;
```

`display_name`, `organization_id` and `updated_at` are the only columns the
customers table requires beyond the id, which is why they are the only ones
needing a value invented here.

The `note` is worth reading before importing rather than after — it is the
answer to "what do you do?", and it is the best signal available about which
trade to build for first.
