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
2. **Fill in the legal entity and a monitored contact address** in
   `src/lib/brand.ts`. Both are still placeholders. A privacy notice naming
   nobody gives a visitor no one to exercise their rights against, and the
   legal entity is not necessarily the product name — if you trade through a
   company, that company's registered name belongs there.
3. **Have the privacy notice reviewed.** It accurately describes what the form
   does, which is the necessary starting point, but it has not been read by a
   lawyer.
4. **Remove the `robots: noindex`** in `src/app/layout.tsx`, once 2 is done.
5. **Check the pricing claims.** The page states the model — per location,
   users free — and no figures. If figures are added, they become a promise.

## Colour

`--color-accent` is the logo orange. It measures 2.76:1 on white, which is
fine for a mark and fails WCAG AA for anything read as text. Use
`--color-accent-ink` (4.76:1 on the canvas, 5.06:1 behind white button text)
wherever the orange has to carry words.

## Configuring the email service

The list lives with an email provider, not in the product database. The reason
is sending: there is no email infrastructure in the platform until Phase 11, so
a self-hosted list could capture addresses but could not confirm them or mail
them at launch.

Set these where the site is deployed:

```bash
WAITLIST_PROVIDER=buttondown   # or convertkit | resend | log
WAITLIST_API_KEY=...           # secret, server-side only
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
