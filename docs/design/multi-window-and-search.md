# Two monitors and quick search: design

Status: **proposed, awaiting the product owner's approval.** Nothing built.

Goal: someone at a desk can spread RelaStack across two screens (schedule on
one, customers on the other) and jump to anything by typing. We use real
browser windows rather than tabs built inside the app: the browser already does
tabs, windows and dragging to another monitor better than a page can. The work
is making the app behave well when it is open in several places at once.

## 1. Windows keep each other up to date

Today a change in one window does not appear in another until it is reloaded.

- **Same person, several windows.** Every successful change posts a message on
  a browser channel (`BroadcastChannel`). Every other RelaStack window of that
  browser refreshes its data within about a second. Typing in progress is kept,
  since a refresh re-renders the page but leaves open forms alone.
- **Changes made by colleagues.** A window refreshes when you come back to it
  (focus or visibility), and every 60 seconds while it is on screen. It never
  refreshes while hidden, so an idle database can still sleep.
- **Signing out** in one window signs out all of them and sends each to the
  sign-in page.
- All writes in the web app go through one helper (`apiWrite`), which does the
  announcing. About 17 components move onto it; none keeps its own fetch-and-
  refresh.
- Not in this stage: instant push of colleagues' changes from the server. The
  60-second refresh covers research; push can come later.

## 2. Everything has its own address

Middle-click, right-click "open in new window", and search results all need a
page to land on.

- New pages: **`/jobs/[id]`** (details, crew, status, edit) and
  **`/tasks/[id]`** (details, edit, status). Today jobs have no page of their
  own and tasks are edited only inside the list.
- Schedule entries and task rows become real links, so they open in a new
  window like any link.
- Already fine: `/customers/[id]`, and the filters on Schedule, Tasks and
  Customers, which are already in the address.

## 3. Using a wide screen

Most pages are a narrow column today, so a large monitor is mostly empty.

- **Wide:** Schedule, Customers, Tasks, the dashboard and the staff console
  use the full width, up to about 1600px. The week view gets proper room per
  day.
- **Stay narrow, for readability:** forms, a single customer, job or task,
  Account, Billing and Help.
- The navigation bar spans the full width.

## 4. Quick search: Ctrl+K (⌘K on a Mac)

Press Ctrl+K anywhere, or click the search box in the navigation bar.

- **Finds:** customers and leads (name, email, phone, address), jobs (title,
  customer, address), tasks (title), people on the team, and locations. Up to
  five of each, best match first.
- **Also offers actions:** "Go to Schedule", "New customer", "New task", "Ask
  for help"… Only the ones the person could reach from the navigation anyway.
- **Keys:** arrows to move, Enter to open, **Ctrl+Enter to open in a new
  window** (for the other monitor), Esc to close.
- **Recently opened:** the palette shows the last eight things you opened
  before you type. Stored in that browser only.

### The rule that matters: search shows nothing the lists would not

- One endpoint, `GET /api/v1/search?q=…` (two characters minimum). Each kind
  of result comes from the **same service and the same visibility filter** as
  its list page. No second path to the data.
- A Location Manager finds only the customers, jobs and tasks their locations
  allow. An employee finds only what they could open.
- A task never reveals a customer the reader may not see (the task rule in
  CLAUDE.md), and that holds in search results too.
- Modules the business has not switched on return nothing (no customers
  without CRM, no jobs without Scheduling).
- Staff console search stays separate and is unchanged.

## 5. Navigation: work on the left, account on the right

The product owner's idea (2026-09-27): account management should not be mixed
in with the modules. Proposed here because the bar is being rebuilt for search
anyway.

- **Left, the work:** Dashboard · Customers · Schedule · Tasks. These are the
  modules a business works in; industry packs land here later.
- **Right, tools and you:** Search (Ctrl+K) · Notifications · Help · the
  person's name ▾.
- **The name ▾ menu:** Your profile (name, password, email notifications) ·
  Business settings · Locations · Team · Modules · Billing · Staff console
  (staff only) · Sign out.
- Every entry keeps today's permission and module checks. An employee sees
  only what they may open, often just their profile and Sign out.
- The menu opens with a click or keyboard, closes on Esc or a click outside,
  and each entry is an ordinary link, so it can open in a new window.
- On narrow screens the whole bar folds into one menu button.

## Tests to write, and break on purpose

Search:

- never returns another business's records
- a scoped user never sees customers or jobs outside their locations
- a task result never carries a customer name the reader cannot see
- a module that is switched off returns nothing
- fewer than two characters is refused

Pages:

- `/jobs/[id]` and `/tasks/[id]` answer 404 exactly where the list would have
  hidden the item

Sync (unit-tested helper):

- a write announces, and a failed write does not

## Not in this stage

- Tabs or split panes inside the app
- Instant server push of colleagues' changes
- Offline use
- The phone layout for crews, and first-run setup (both on the list for later)

## Open questions for the product owner

1. **Search scope:** also search the text of customer notes? Proposed: not
   yet. Names, contact details and addresses find almost everything, and notes
   are the most sensitive text in the product.
2. **Refresh interval:** 60 seconds for colleagues' changes? Proposed: yes.
   Shorter keeps the database awake and costs more once past the free tier.
