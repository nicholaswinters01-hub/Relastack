# Putting BizFoundry online

From a working local site to a real domain collecting real addresses.

Roughly an hour of actual work, most of it waiting for DNS.

## What you have to do yourself

Three things need your name, your card or your identity, so they are yours to
do rather than mine: **registering the domain**, **creating the hosting
account**, and **creating the email-service account**. Everything either side
of those is below.

---

## 1. Push the repository somewhere private

Vercel and every alternative deploy from a git repository.

> **Private, not public.** `LICENSE` is proprietary, all rights reserved. This
> repository is the entire product — the tenant isolation, the billing logic,
> the schema. Publishing it to collect email addresses would be an expensive
> mistake.

Secrets are already safe: `.gitignore` covers `.env`, and nothing matching a
credential is tracked. Verified before writing this.

```bash
gh repo create bizfoundry --private --source=. --remote=origin --push
```

If you would rather not use the `gh` CLI, create an empty **private** repo on
GitHub and:

```bash
git remote add origin git@github.com:<you>/bizfoundry.git
git push -u origin main
```

## 2. Register the domain

`bizfoundry.com` if it is free. Cloudflare, Namecheap and Porkbun are all fine;
Cloudflare sells at cost and does not raise the price on renewal, which most
registrars do.

Check the name is not already a trademark in your line of business before you
commit to it — a rename after launch means the domain, the logo, the emails you
have already sent and every link anyone has shared.

While you are there, decide on the address the privacy notice will publish.
`hello@bizfoundry.com` needs to actually reach you: it is where deletion
requests arrive, and ignoring one is the kind of thing regulators care about.
Most registrars will forward an address to your personal inbox for free.

## 3. Create the email-service account

Pick one. This decides whether you can email the list at launch, which is the
entire point of having one.

| Service        | Free tier   | Sends its own confirmation          |
| -------------- | ----------- | ----------------------------------- |
| **Buttondown** | 100 subs    | Yes — double opt-in built in        |
| ConvertKit     | 10,000 subs | Yes                                 |
| Resend         | audiences   | **No** — you would have to build it |

Buttondown is the one I would pick for a waitlist: double opt-in out of the
box, and the adapter already creates subscribers as `unactivated` so nobody
joins the list until they click the link in their confirmation email.

Create the account, then copy the API key. Do not paste it into the repository
— it goes in the host's environment settings in step 5.

## 4. Deploy

The site needs a Node runtime. It is **not** a static export: there is
middleware issuing a per-request CSP nonce, and a route handler holding your
API key server-side. Plain static hosting (S3, GitHub Pages) will not run
either.

Vercel is the least friction for Next.js. Import the repository, then set:

| Setting                                            | Value            |
| -------------------------------------------------- | ---------------- |
| Root Directory                                     | `apps/marketing` |
| Include source files outside of the Root Directory | **on**           |
| Framework Preset                                   | Next.js          |
| Install Command                                    | _leave default_  |
| Build Command                                      | _leave default_  |

The "include source files outside" toggle is the one that catches people: this
is a pnpm workspace, so the lockfile lives at the repository root and the
install fails without it.

`apps/marketing` deliberately depends on no workspace package — only `next`,
`react` and `zod`. That was a design choice and it pays off here: the marketing
site can build without the API, the database package or the shared contracts.

**Alternatives.** Netlify works the same way. On a VPS, add
`output: 'standalone'` to `next.config.mjs`, then `pnpm --filter
@platform/marketing build` and run `node .next/standalone/server.js` behind
nginx.

## 5. Set the environment variables

In the host's project settings, for the Production environment:

```
NEXT_PUBLIC_SITE_URL   https://bizfoundry.com
WAITLIST_PROVIDER      buttondown
WAITLIST_API_KEY       <the key from step 3>
```

`WAITLIST_LIST_ID` is only needed for ConvertKit or Resend.

`NEXT_PUBLIC_SITE_URL` matters more than it looks. It is what turns the social
card image into an absolute URL; without it every link anyone shares carries an
image URL pointing at `localhost`, which fails silently and looks like nothing
is wrong.

Never prefix `WAITLIST_API_KEY` with `NEXT_PUBLIC_`. That prefix means "ship
this to the browser", and anyone could then read or edit your list.

## 6. Point the domain at it

Add the domain in the host's dashboard, then create the records it asks for at
your registrar — usually an `A` record for the apex and a `CNAME` for `www`.
Propagation is typically minutes and occasionally hours. HTTPS is issued
automatically once the records resolve.

---

## Before you send anyone the link

- [ ] `public/logo.png` added — needed for the favicon and the social card
- [ ] `BRAND.legalEntity` set to the entity that actually controls the data,
      which may be a company rather than "BizFoundry"
- [ ] `BRAND.contactEmail` set to an address you genuinely read
- [ ] Privacy notice read by a lawyer
- [ ] `robots: { index: false }` removed from `src/app/layout.tsx` — it is
      there so a half-finished page cannot get indexed

## After it is live, check it actually works

Do this once, properly. A waitlist that silently drops signups is worse than no
waitlist, because you will not find out for months.

1. Sign up with a real address you control.
2. Confirm the confirmation email arrives, and click the link in it.
3. Check the subscriber appears in the email service.
4. Sign up with the same address again — you should get the same message, not
   an error. (It answers identically whether an address is new or already on
   the list, so the form cannot be used to test whether someone signed up.)
5. Turn JavaScript off and sign up again. It should still work and land you on
   `/thanks`.
6. Paste the URL into a Slack or iMessage and check the preview card renders.
