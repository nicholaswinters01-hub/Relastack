# Employees and groups: design

Status: **proposed, awaiting the product owner's answers** to the questions at
the end. Nothing built.

The idea (product owner, 2026-09-27): call the people page "Employees", and
let a business group its people, so it can look at just the field crew or just
the office and accounting staff.

## 1. "Team" becomes "Employees"

- The page, the account-menu entry and quick search say **Employees**. The
  address moves from `/team` to `/employees`, and `/team` redirects there so
  old links keep working.
- Stays core, not a module: every business has people. CLAUDE.md's planned
  Employees module (availability, certifications and so on) would later add to
  this page rather than create a second one.

## 2. Groups

Groups are **labels a business gives its people**: "Field crew", "Office",
"Accounting", "Mowing crew B"…

- **Many to many:** a person can be in several groups (a foreman who also does
  estimates).
- **Grant nothing.** Roles decide what someone may do; locations decide where.
  A group is only for finding and organising people. Written into the code and
  proven by a test, so no one later mistakes "in the Office group" for "may see
  billing".
- **Managed by** people with `member.manage` (owners and admins): create,
  rename, delete, and put people in or out. Everyone who can see the Employees
  page sees the groups.
- **Deleting a group** removes the label only. Nobody loses anything.

### Where groups are used

- **Employees page:** filter chips (All · Field crew · Office · …), and each
  person's groups shown beside their name.
- **Booking a job and editing a crew:** filter the crew picker to a group, so
  scheduling shows the field people rather than everyone.
- **Quick search:** a person's groups appear under their name.
- **Later** (noted, not built): automation ("tell the Office group"), and
  reports by group.

## 3. Data

- `member_groups`: organization, name (unique per business, ignoring case),
  colour, sort order.
- `member_group_members`: group and membership, with the organization copied in
  and checked by a trigger to match both (the add-on pattern). Removed
  automatically when either the group or the person goes.
- Row-level security on both, keyed on organization, like every tenant table.
  **No staff policy:** the staff console has no need to see how a business
  organises its people.

## 4. API

- `GET /groups`, `POST /groups`, `PATCH /groups/:id`, `DELETE /groups/:id`
- `PUT /organizations/current/members/:membershipId/groups` with `{ groupIds }`
  sets a person's groups in one go.
- The members list returns each person's groups and accepts `?groupId=`.

## 5. Tests to write, and break on purpose

- Another business's groups are invisible, and 404 when addressed.
- Only `member.manage` can create groups or change membership; an employee is
  refused with 403.
- **Being in a group grants nothing:** an employee added to "Office" still
  cannot open billing or anyone else's tasks.
- Duplicate names are refused, ignoring case.
- Deleting a group leaves the people and their roles untouched.
- A person can't be added to a group from another business (the trigger).

## Open questions for the product owner

1. **Start new businesses with two groups, "Field crew" and "Office"?**
   Proposed: yes, renamable and deletable, so the feature is visible on day
   one.
2. **Colour per group** (a small dot beside names and on the crew picker)?
   Proposed: yes, from a fixed set of eight.
3. **Move the address to `/employees`**, with `/team` redirecting? Proposed:
   yes.

---

## Also approved, to build first (2026-09-27): option C for deleting customers

A customer who has any jobs, recurring series or tasks cannot be deleted
permanently. The API answers 409, naming the counts ("has 3 jobs and 1 task —
remove (archive) them instead"), and the page shows that instead of the typed
confirmation. It needs a test that tries it. A customer with no work attached
can still be deleted, by an owner, as today.
