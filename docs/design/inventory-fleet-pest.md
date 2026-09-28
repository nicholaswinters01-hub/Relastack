# Inventory, Fleet and the Pest Control pack: design

Status: **approved 2026-09-28** (answers at the end). **Stage 1 complete** (built and approved 2026-09-28). **Stage 2 complete** (built and approved 2026-09-28). **Stage 3 complete** (built and approved 2026-09-28). Pulls Phase 16 (Inventory)
forward, with part of Phase 17 (packs extending modules), at the product
owner's request on 2026-09-28.

The idea (product owner, 2026-09-28): industry packs do not become separate
products. They **plug into the core modules** and add what a trade needs. The
first test pack is **pest control**, which the product owner knows firsthand.
It brings a **Fleet** module with it. Fleet is its own module so that other
packs can include it later, but nobody picks it on its own.

Answers so far:

- The pest control test pack starts with **application records**. Stations at
  properties, pest-specific customer fields and a starter product list are
  noted for later.
- **Fleet** is a module of its own, cannot be chosen alone, and comes with the
  pest control pack.

## 0. How a pack plugs in

Three kinds of entry in the module registry:

| Kind            | Example        | Can a business choose it?                                    |
| --------------- | -------------- | ------------------------------------------------------------ |
| Module          | CRM, Inventory | Yes, through its plan or as an add-on                        |
| Included module | Fleet          | No. It comes with a pack (or later, a plan) that includes it |
| Pack            | Pest control   | Yes: $35/mo, or included in Pro and Business                 |

- The registry gains `kind` and `includes`. Being entitled to a pack means
  being entitled to everything it `includes`. The entitlement service works
  this out in one place, so business logic still only asks "is this
  organization entitled to fleet?"
- **Connection points.** A pack adds to core records through a fixed, small
  set of places. Core code never asks which trade a business is in (rule 12):
  1. **Extra fields on core records.** The pack declares them in the registry,
     with a Zod schema, and they are stored in a `pack_fields` JSONB column on
     the record. This test uses them on items (EPA registration number), on
     employees (applicator license) and on materials used on a job (target
     pest, area, method).
  2. **Stock places.** The core holds stock at branches. Fleet adds vehicles
     as places.
  3. **Sections on a page.** A pack can add a section to the job page, such as
     "Treatments".
- **Turning a pack off hides, never deletes.** Its fields and sections
  disappear, and the data stays for when the pack comes back. This matters
  most for application records, which a business may be legally required to
  keep.
- **How a business gets the pack, for now:** billing is by hand, so staff
  switch it on from the staff console as an add-on, with a reason, and it is
  audited like every other change. "Pick the pack your plan includes" comes
  later, with self-serve billing.

## Stage 1: core inventory

What every business with stock needs. Nothing trade-specific.

**Items.**

- Fields: name, SKU (optional, unique per business), unit (each, bag, gallon,
  oz, lb…), category, cost (optional) and a low-stock level.
- Managed by owners and admins (`inventory.configure`, organization-wide),
  like custom fields.
- Archived, never deleted: an item with history keeps it.

**Stock places.**

- A place is where stock sits. In stage 1, each branch is a place, created
  automatically.
- Every place **belongs to a branch** (a van will belong to its home branch).
  That keeps permissions the same everywhere: a Location Manager manages the
  stock at their branches and nothing else.

**Stock changes: a ledger, never edited.**

- Every change is a row: item, place, quantity (+ or −), reason, note, who and
  when.
- Reasons: **received, used, counted, damaged or lost, moved**. A move writes
  two rows, out of one place and into another, tied together.
- **On hand is always the sum.** Rows are never updated or deleted; the
  application role gets no UPDATE or DELETE, the same as billing payments. A
  mistake is fixed with a correcting row, so the history always explains the
  number.
- A **count** records the difference between what the system expected and
  what was counted, so drift shows up as its own line.
- Quantities allow decimals (2.5 gallons).
- **Going below zero warns, and can be saved anyway**, like job conflicts. In
  real life product gets used before the delivery is entered, and refusing
  would only push people to enter wrong numbers. Negative stock shows in red
  until it is corrected.

**Pages.**

- `/inventory`: items with on hand per place you can see, a filter by place,
  and a low-stock view.
- An item's page: quantities at each place, and its history.
- Actions: Receive, Use, Count, Move, Damaged/lost.
- The dashboard shows a low-stock count, run through the same visibility
  filter as the list ("an aggregate is still a disclosure").

**Permissions.**

- `inventory.read` and `inventory.write` are scoped: writes use `hasAt(branch)`,
  and reads use `hasAnywhere` plus the filter.
- `inventory.configure` is organization-wide.
- Admins get all three. Location Managers get read and write at their
  branches. Employees get read. Technicians record what they **use** through
  their own jobs in stage 3, with authority from being on the crew.
- **Each branch decides whether employees may take stock** (product owner:
  some shops have a manager oversee every item taken, others let techs take
  what they need). A branch setting, "Employees can take stock", is off by
  default. It is changed by anyone who can write inventory at that branch
  (managers and admins).
  - When it is on, employees assigned to that branch may record **use** and
    **move** stock there, for example from the shop to their van.
  - Receiving, counting and damaged or lost stay with managers and admins.
  - The setting is checked by the inventory service alongside `hasAt`. It is
    not a role change, so it can never grant anything outside inventory at
    that branch. A test proves an employee at another branch gets nothing
    from it.
- Gated by `@RequireModule(inventory)`. A lapsed business can still read.

## Stage 2: Fleet (included module)

**Vehicles and equipment.**

- Name ("Van 3"), kind (vehicle, trailer, equipment), make, model and year,
  plate, VIN or serial number, home branch.
- An assigned driver (optional), and a status: active, in the shop or retired.
- A meter: miles, engine hours or none.

**Readings.** Odometer or hours with a date, append-only. The latest is
current. The assigned driver may log readings for their own vehicle: authority
from the row, like a task's assignee.

**Service reminders.**

- "Oil change every 5,000 miles or 6 months", "Registration expires 3/1".
- Due and overdue appear on the fleet page and the dashboard.
- "Mark done" writes a service record: date, reading, cost and note.
- **Not in the bell**: it stays quiet on purpose. The driver could be added
  later if wanted.

**Vehicles hold stock.** With Inventory on, each vehicle is a stock place that
belongs to its home branch. "Move 3 cases from the Tampa shop to Van 2" is an
ordinary move.

**A vehicle on a job.**

- A job can name the vehicle it uses.
- Booking a vehicle on two overlapping jobs **warns and can be overridden**,
  the same as crew conflicts.

**Permissions and entitlement.**

- `fleet.read` and `fleet.write` are scoped to the home branch.
- Gated by `@RequireModule(fleet)`, which a business has only through a pack
  that includes it.

## Stage 3: materials used on jobs, and the Pest Control pack

**Core: materials used on a job** (Inventory + Scheduling).

- The crew records "used 2 gal of X on this job".
- The stock comes off the job's vehicle, or off the branch if the job has no
  vehicle.
- Recorded as a "used" ledger row linked to the job, so the job page, the
  item's history and the stock level all agree.
- A mistake is **voided with a reason**, never edited. The void adds a
  correcting row.

**Pest Control pack: application records.** The pack adds its fields to that
same "materials used" line. This is the plug-in idea being tested:

- **On the line:** target pest(s), area treated (interior, exterior,
  perimeter, attic, crawlspace…), method (spray, bait, dust, granular), and the
  amount of product applied.
- **On items:** EPA registration number and active ingredient.
- **On employees:** applicator license number and expiry. It is filled in on
  the record from the person who applied it, so the record stays correct if
  the license later changes.
- **On the job page:** the lines appear as a **Treatments** section.
- **Records:**
  - a printable application record per job
  - a customer's treatment history on their page
  - a date-range export (CSV) for an inspection or audit
- **Kept:** records cannot be edited or deleted; a void keeps the original
  line. Turning the pack off hides them and keeps them.

The product owner should check the list of fields against what Florida
requires. The owner knows it firsthand, and the design should follow the rule,
not a guess.

## Data (summary)

- `inventory_items`, `stock_places` and `stock_movements` (the ledger:
  append-only, RLS).
- `fleet_assets`, `fleet_readings`, `fleet_reminders` and
  `fleet_service_records`.
- `jobs.vehicle_id` (nullable).
- `pack_fields` JSONB on items, memberships and stock movements.
- Every table has RLS keyed on organization. **No staff policies**: stock,
  vehicles and treatments are what a business keeps, not account information.
- `organization_id` is copied onto child rows and checked by triggers (the
  add-on pattern), including that a movement's place and item belong to the
  same business.

## Tests (every rule, and the negative case)

- **Isolation:** another business's items, places, vehicles and treatments
  return 404.
- **Scope:** a Location Manager cannot receive, count or move stock at another
  branch, and cannot see its levels, not even as a dashboard count.
- **The ledger:** on hand equals the sum. The application role cannot UPDATE
  or DELETE a movement, proved by trying.
- **Entitlement:**
  - Fleet is refused without the pest pack and allowed with it, tested by
    calling the routes.
  - Turning the pack off hides treatments but keeps the rows.
- **Authority from the row:** a crew member records treatments on their own
  job only, and a driver logs readings on their own vehicle only.
- **Pack fields** are validated by the pack's schema. An unknown pest field is
  refused.

## Answers (product owner, 2026-09-28)

1. **The pest pack includes Fleet and Inventory.** (This touches the parked
   Business-plan pricing question.)
2. **Negative stock warns and can be saved anyway.**
3. **Who takes stock depends on the business:** a per-branch "Employees can
   take stock" setting (see stage 1, Permissions).
4. **Low-stock level:** one per item, company-wide. Per-place levels can come
   later.

## Stage 2 as built (2026-09-28)

- **Packs are plumbing now.** The registry has `kind` and `includes`, and the
  Pest Control pack is registered. It has no features of its own until stage 3,
  but it brings Fleet and Inventory. The trial includes it. Staff switch it on
  for a paying business from the staff console, with a reason and a monthly
  price, both recorded in the audit trail.
- **Equipment carries no stock.** Only vehicles and trailers are stock places.
- **Readings** are append-only. One lower than the last warns and can be
  recorded anyway.
- **Reminders** repeat every so many months, miles or hours, whichever comes
  first, or fall due once by a date. Marking one done counts the next interval
  from when it was actually done. A one-off reminder is then finished.
- **Service records** can be removed by a manager. They are not a legal record
  the way application records will be.
- **The usual driver** sees their vehicle wherever it is kept, logs its
  readings, and takes stock from it, whatever their role. Authority comes from
  the row, like a task's assignee.
- **A vehicle on a job** is set from the job page by anyone who can book jobs
  at that branch. A clash names the times, not the other job, which may be at a
  branch the reader cannot see.

## Stage 3 as built (2026-09-28)

The product owner confirmed the record's contents: product with EPA
registration number, amount, target pests, areas, method, applicator and
license, and date and time. Added to that: **weather** (wind and temperature),
**mix rate**, and a **customer signature**. The crew on the job records it.

- **Pack fields** are a catalogue in `@platform/shared` (`PACK_FIELDS`). The
  core validates each enabled pack's part and never reads inside it. Items get
  an EPA number and active ingredient, people an applicator license and
  expiry, and a treatment line the pest fields.
- **Materials used on a job** are core. Stock is taken from the job's vehicle,
  else its branch, and a line is voided with a reason, never edited. With the
  pack on, every line must carry the pest fields. With it off, lines are plain
  materials, and existing records are hidden but kept.
- **Records are evidence.** A line copies the license and EPA number as they
  were. A job with records or a signature cannot be deleted. A series visit
  with records survives rule changes.
- **Customer sign-off** is drawn on the phone, append-only, and the latest is
  shown.
- **Pages:**
  - Treatments and Sign-off sections on the job page
  - a printable application record (`/jobs/:id/record`)
  - a treatment history on the customer's page
  - `/pest-records` with a date range and a CSV download, dated in each
    branch's time zone
  - license numbers on the Employees page
  - EPA fields on items

Not yet: stations at properties, pest customer fields, a starter product list,
and choosing a pack from a plan. The date-range filter counts UTC days, so a
late-evening visit can fall on the next day's filter. The CSV itself shows
local dates.
