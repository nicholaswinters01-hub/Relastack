# Help desk (Phase 19c): design

Status: **approved 2026-09-27** with the proposed answers to all three questions (see the end). Being built.

## What it is

A **Help** page in the app where anyone in a business sends a question, a
problem, or an idea. It lands in a staff inbox at `/staff/help`. A staff reply
appears in the app and is emailed to the person who asked. During research
this doubles as the feedback channel, kept per business.

## Data

- `support_requests`: organization, opened by (user id + email, kept if the
  person is later removed), subject, kind (`QUESTION` / `PROBLEM` / `IDEA`),
  status (`OPEN` / `WAITING_ON_CUSTOMER` / `RESOLVED`), created, updated,
  resolved.
- `support_messages`: request, organization (denormalised, trigger-checked
  like add-ons), author, `fromStaff`, body, created. **Append-only**: no
  UPDATE or DELETE for the app role, like the audit trail.

## Who sees what (enforced by the backend, not the UI)

- Business side, through `withTenant()`: RLS keeps every business to its own
  requests. Within a business the service narrows further: whoever opened a
  request sees it, and so do people with organization-wide
  `organization.write` (owners/admins). Anyone else gets 404, like every other
  visibility filter here. Other members do not see colleagues' requests.
- Staff side, through `withStaff()`: new per-command staff policies on these
  two tables only. SELECT, INSERT of messages naming the caller, UPDATE of
  status. Still **no** staff policy on any customer-data table.
- Cross-business access returns 404.

## Rules

- A business can have at most 10 requests opened per day (stops a stuck
  script or an angry loop filling the inbox). Messages capped at 5,000 chars.
- Customer replies on a `WAITING_ON_CUSTOMER` request reopen it (`OPEN`).
- Staff replies and status changes are written to `staff_audit_events`.
- Every change emits into `domain_events` in the same transaction; the
  dispatcher emails the requester on a staff reply (outbox, so a mail outage
  retries rather than losing it). Also a bell notification: work addressed to
  a specific person, which fits the quiet-bell rule.
- New requests email staff at `SUPPORT_NOTIFY_EMAIL` (config, default
  hello@relastack.com) so nobody has to watch the console.
- No attachments in this phase.

## Screens

- `/help`: my requests (and, for admins, the business's), a "New request"
  form, and each request as a thread with a reply box.
- `/staff/help`: inbox with Open / Waiting / Resolved filters, newest first,
  business name and plan beside each; thread view with reply and status.
- Staff overview tile: open requests. Business page: that business's requests.

## Tests to write (and break on purpose)

Owner-only visibility and the negative (a member cannot read a colleague's
request); cross-business 404; staff can read requests but still no customers;
messages cannot be edited or deleted by anyone; staff cannot post as someone
else; the daily cap; reply email goes out once even on redelivery; read-only
business can (or cannot, per question 3) open a request.

## Decisions (approved 2026-09-27: "go with your suggestions")

1. **Who in a business sees a request?** Proposed: the person who opened it,
   plus owners/admins. Alternative: everyone in the business.
2. **Email you when a request arrives?** Proposed: yes, to
   hello@relastack.com.
3. **Can a read-only (lapsed) business ask for help?** Proposed: yes, since
   someone who cannot pay or cannot work out why they are read-only is exactly
   who needs help. This amends rule 13 in CLAUDE.md, which today allows
   `@AllowsWhenReadOnly` only on billing endpoints.
