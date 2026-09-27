import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { StaffAction, StaffNoteForm } from '@/components/staff-actions';
import { getStaffBusiness, getStaffIdentity } from '@/lib/staff-api';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Never';

/** yyyy-mm-dd, for a date input's default. */
const inputDate = (d: Date) => d.toISOString().slice(0, 10);

const STATUS_LABEL: Record<string, string> = {
  TRIALING: 'On trial',
  ACTIVE: 'Paying',
  PAST_DUE: 'Payment failed (grace period)',
  SUSPENDED: 'Read-only',
  CANCELLED: 'Cancelled',
};

const ACTION_LABEL: Record<string, string> = {
  'business.viewed': 'Opened this business',
  'trial.extended': 'Extended the trial',
  'plan.changed': 'Changed the plan',
  'business.suspended': 'Suspended the business',
  'business.reactivated': 'Reactivated the business',
  'member.unlocked': 'Cleared a sign-in lockout',
  'member.signed-out': 'Signed someone out everywhere',
  'invitation.reissued': 'Sent a new invitation link',
  'note.added': 'Added a note',
};

export default async function StaffBusinessPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getStaffIdentity())) notFound();

  const { id } = await params;
  const detail = await getStaffBusiness(id);
  if (!detail) notFound();

  const { business, subscription } = detail;
  const onTrial =
    subscription !== null &&
    (subscription.status === 'TRIALING' ||
      (subscription.status === 'SUSPENDED' && subscription.trialEndsAt !== null));
  const suggestedTrialEnd = inputDate(new Date(Date.now() + 14 * 86_400_000));

  return (
    <>
      <AppNav current="staff" />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <Link
          href="/staff"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          All businesses
        </Link>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{business.name}</h1>
          {business.status === 'SUSPENDED' ? (
            <StaffAction
              label="Reactivate business"
              path={`businesses/${business.id}/status`}
              fixed={{ status: 'ACTIVE' }}
            />
          ) : (
            <StaffAction
              label="Suspend business"
              path={`businesses/${business.id}/status`}
              fixed={{ status: 'SUSPENDED' }}
              danger
            />
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Joined {date(business.createdAt)}
          {business.status === 'SUSPENDED' && (
            <span className="text-[var(--color-bad)]">
              {' '}
              · Suspended: nobody in this business can use the app
            </span>
          )}
        </p>

        {/* ------------------------------------------------------------- */}
        <Section title="Subscription">
          {!subscription ? (
            <p className="text-sm text-[var(--color-muted)]">No subscription.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <Fact label="Plan" value={subscription.planName} />
                <Fact
                  label="Status"
                  value={STATUS_LABEL[subscription.effectiveStatus] ?? subscription.effectiveStatus}
                />
                <Fact
                  label="Access"
                  value={subscription.accessLevel === 'full' ? 'Full' : 'Read-only'}
                />
                {subscription.trialEndsAt && (
                  <Fact label="Trial ends" value={date(subscription.trialEndsAt)} />
                )}
                <Fact label="Current period ends" value={date(subscription.periodEndsAt)} />
                {subscription.graceEndsAt && (
                  <Fact label="Grace ends" value={date(subscription.graceEndsAt)} />
                )}
                <Fact label="Monthly charge" value={money(subscription.monthlyChargeCents)} />
                {subscription.addOns.length > 0 && (
                  <Fact
                    label="Add-ons"
                    value={subscription.addOns
                      .map((a) => `${a.moduleKey} (${money(a.priceCents)})`)
                      .join(', ')}
                  />
                )}
              </dl>

              <div className="mt-4 flex flex-wrap gap-2">
                {onTrial && (
                  <StaffAction
                    label={subscription.status === 'SUSPENDED' ? 'Restart trial' : 'Extend trial'}
                    path={`businesses/${business.id}/trial`}
                    fields={[
                      {
                        name: 'until',
                        label: 'Trial ends on',
                        type: 'date',
                        defaultValue: suggestedTrialEnd,
                      },
                    ]}
                  />
                )}
                <StaffAction
                  label="Change plan"
                  path={`businesses/${business.id}/plan`}
                  fields={[
                    {
                      name: 'planKey',
                      label: 'New plan (keeps any trial and billing dates as they are)',
                      type: 'select',
                      options: detail.plans
                        .filter((plan) => plan.key !== subscription.planKey)
                        .map((plan) => ({
                          value: plan.key,
                          label:
                            plan.maxLocations === null
                              ? plan.name
                              : `${plan.name} (up to ${plan.maxLocations} location${plan.maxLocations === 1 ? '' : 's'})`,
                        })),
                    },
                  ]}
                />
              </div>
            </>
          )}
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title={`People (${detail.members.length})`}>
          <div className="flex flex-col divide-y divide-[var(--color-line)]">
            {detail.members.map((member) => (
              <div key={member.userId} className="flex flex-col gap-2 py-3 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-medium">{member.name ?? member.email}</span>
                    <span className="ml-2 text-xs text-[var(--color-muted)]">
                      {member.role === 'OWNER' ? 'Owner' : 'Member'}
                    </span>
                    {member.name && (
                      <div className="text-xs text-[var(--color-muted)]">{member.email}</div>
                    )}
                  </div>
                  <div className="text-right text-xs text-[var(--color-muted)]">
                    Last sign-in {dateTime(member.lastLoginAt)}
                    <br />
                    Signed in on {member.activeSessions} device
                    {member.activeSessions === 1 ? '' : 's'}
                  </div>
                </div>

                {(member.lockedUntil || member.userStatus === 'SUSPENDED') && (
                  <p className="text-xs text-[var(--color-bad)]">
                    {member.userStatus === 'SUSPENDED'
                      ? 'This person’s account is suspended.'
                      : `Locked out of sign-in until ${dateTime(member.lockedUntil)} after ${member.failedLoginAttempts} wrong passwords.`}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {member.lockedUntil && (
                    <StaffAction
                      label="Clear sign-in lockout"
                      path={`businesses/${business.id}/members/${member.userId}/unlock`}
                    />
                  )}
                  {member.activeSessions > 0 && (
                    <StaffAction
                      label="Sign out everywhere"
                      path={`businesses/${business.id}/members/${member.userId}/sign-out`}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title={`Locations (${detail.locations.length})`}>
          {detail.locations.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {detail.locations.map((location) => (
                <li key={location.id}>
                  {location.name}
                  <span className="text-[var(--color-muted)]">
                    {[location.city, location.region].filter(Boolean).length > 0 &&
                      ` · ${[location.city, location.region].filter(Boolean).join(', ')}`}
                    {location.status !== 'ACTIVE' && ' · inactive'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title="Modules">
          <p className="text-sm">
            {detail.modules
              .filter((m) => m.enabled)
              .map((m) => m.key)
              .join(', ') || 'None switched on'}
          </p>
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title="Invitations">
          {detail.invitations.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">None.</p>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--color-line)]">
              {detail.invitations.map((invitation) => {
                const expired = new Date(invitation.expiresAt).getTime() < Date.now();

                return (
                  <div key={invitation.id} className="flex flex-col gap-2 py-3 first:pt-0">
                    <div className="flex flex-wrap justify-between gap-2 text-sm">
                      <span>{invitation.email}</span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {invitation.status === 'PENDING'
                          ? expired
                            ? `Expired ${date(invitation.expiresAt)}`
                            : `Pending · expires ${date(invitation.expiresAt)}`
                          : invitation.status === 'ACCEPTED'
                            ? 'Accepted'
                            : 'Revoked'}
                      </span>
                    </div>
                    {invitation.status === 'PENDING' && (
                      <StaffAction
                        label="New invitation link"
                        path={`businesses/${business.id}/invitations/${invitation.id}/reissue`}
                        returnsLink
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title="Notes (staff only)">
          <StaffNoteForm businessId={business.id} />
          {detail.notes.length > 0 && (
            <ul className="mt-4 flex flex-col gap-3">
              {detail.notes.map((note) => (
                <li key={note.id} className="rounded-lg bg-[var(--color-canvas)] p-3 text-sm">
                  <p className="whitespace-pre-wrap">{note.body}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {note.authorEmail} · {dateTime(note.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ------------------------------------------------------------- */}
        <Section title="Staff activity on this business">
          <ul className="flex flex-col gap-2 text-sm">
            {detail.activity.map((event) => (
              <li key={event.id}>
                <span className="font-medium">{ACTION_LABEL[event.action] ?? event.action}</span>
                {event.reason && <span> — “{event.reason}”</span>}
                <div className="text-xs text-[var(--color-muted)]">
                  {event.staffEmail} · {dateTime(event.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
