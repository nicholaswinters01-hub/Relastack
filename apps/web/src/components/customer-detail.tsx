'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ASSIGNABLE_STAGES,
  type CustomerDetail,
  type CustomerStage,
  type CustomFieldDefinition,
  type Tag,
} from '@platform/shared';

interface Props {
  customer: CustomerDetail;
  tags: Tag[];
  fields: CustomFieldDefinition[];
  canWrite: boolean;
  membershipId: string;
}

const STAGE_LABEL: Record<CustomerStage, string> = {
  LEAD: 'Lead',
  ACTIVE: 'Customer',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

/**
 * One customer, with everything attached to them.
 *
 * The stage buttons are the conversion: there is no separate "convert lead"
 * flow because there is no separate record to convert into. Everything below
 * stays exactly where it is.
 */
export function CustomerDetailView({ customer, tags, fields, canWrite, membershipId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  async function send(path: string, method: string, body?: unknown, key = path) {
    setBusy(key);
    setError(null);

    try {
      const response = await fetch(path, {
        method,
        credentials: 'include',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return false;
      }

      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/v1/customers/${customer.id}`;
  const tagIds = new Set(customer.tags.map((tag) => tag.id));

  return (
    <div className="mt-6 flex flex-col gap-8">
      <header>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{customer.displayName}</h1>
          <span className="font-mono text-xs text-[var(--color-muted)]">
            {STAGE_LABEL[customer.stage].toLowerCase()}
          </span>
        </div>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {customer.locationName ?? 'Not assigned to a location'}
          {customer.sharedLocationIds.length > 0 &&
            ` · shared with ${customer.sharedLocationIds.length} other location${
              customer.sharedLocationIds.length === 1 ? '' : 's'
            }`}
          {customer.source && ` · from ${customer.source}`}
        </p>
      </header>

      {error && (
        <p className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {/* --------------------------------------------------------------- */}
      {canWrite && (
        <section className="flex flex-wrap gap-2">
          {ASSIGNABLE_STAGES.map((stage) => (
            <button
              key={stage}
              disabled={busy !== null || customer.stage === stage}
              onClick={() => send(base, 'PATCH', { stage }, stage)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                customer.stage === stage
                  ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                  : 'border-[var(--color-line)]'
              }`}
            >
              {busy === stage ? '…' : STAGE_LABEL[stage]}
            </button>
          ))}
        </section>
      )}

      {/* --------------------------------------------------------------- */}
      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Details
        </h2>
        <dl className="mt-4 flex flex-col">
          <Row label="Email" value={customer.email} />
          <Row label="Phone" value={customer.phone} />
          <Row
            label="Address"
            value={
              [customer.addressLine1, customer.city, customer.region, customer.postalCode]
                .filter(Boolean)
                .join(', ') || null
            }
          />
          <Row label="Owner" value={customer.ownerName} />
          <Row
            label="Customer since"
            value={
              customer.convertedAt ? new Date(customer.convertedAt).toLocaleDateString() : null
            }
          />
          <Row
            label="Last contacted"
            value={
              customer.lastContactedAt
                ? new Date(customer.lastContactedAt).toLocaleDateString()
                : null
            }
          />
          {fields.map((field) => (
            <Row
              key={field.id}
              label={field.label}
              value={formatField(customer.customFields[field.key])}
            />
          ))}
        </dl>
      </section>

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Tags
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {tags.length === 0 && (
            <p className="text-sm text-[var(--color-muted)]">No tags defined yet.</p>
          )}
          {tags.map((tag) => {
            const on = tagIds.has(tag.id);

            return (
              <button
                key={tag.id}
                disabled={!canWrite || busy !== null}
                onClick={() =>
                  send(
                    `${base}/tags`,
                    'POST',
                    {
                      tagIds: on ? [...tagIds].filter((id) => id !== tag.id) : [...tagIds, tag.id],
                    },
                    tag.id,
                  )
                }
                className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${
                  on
                    ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                    : 'border-[var(--color-line)]'
                }`}
              >
                {busy === tag.id ? '…' : tag.name}
              </button>
            );
          })}
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Contacts
        </h2>

        <div className="mt-3 flex flex-col gap-2">
          {customer.contacts.length === 0 && (
            <p className="text-sm text-[var(--color-muted)]">Nobody recorded yet.</p>
          )}
          {customer.contacts.map((contact) => (
            <div
              key={contact.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <div>
                <p className="font-medium">
                  {[contact.firstName, contact.lastName].filter(Boolean).join(' ')}
                  {contact.isPrimary && (
                    <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">main</span>
                  )}
                </p>
                <p className="text-sm text-[var(--color-muted)]">
                  {[contact.title, contact.email, contact.phone].filter(Boolean).join(' · ') ||
                    'No details'}
                </p>
              </div>

              {canWrite && (
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    send(`${base}/contacts/${contact.id}`, 'DELETE', undefined, contact.id)
                  }
                  className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        {canWrite && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            action={async (form) => {
              const ok = await send(
                `${base}/contacts`,
                'POST',
                {
                  firstName: String(form.get('firstName') ?? ''),
                  lastName: String(form.get('lastName') ?? ''),
                  email: String(form.get('email') ?? ''),
                  isPrimary: customer.contacts.length === 0,
                },
                'new-contact',
              );
              if (ok) (document.getElementById('contact-form') as HTMLFormElement | null)?.reset();
            }}
            id="contact-form"
          >
            <input
              name="firstName"
              placeholder="First name"
              required
              className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <input
              name="lastName"
              placeholder="Last name"
              className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <input
              name="email"
              type="email"
              placeholder="Email"
              className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy !== null}
              className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs font-medium disabled:opacity-50"
            >
              Add
            </button>
          </form>
        )}
      </section>

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Notes
        </h2>

        {canWrite && (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await send(`${base}/notes`, 'POST', { body: note }, 'new-note');
              if (ok) setNote('');
            }}
          >
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="What happened?"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy !== null || note.trim() === ''}
              className="self-start rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy === 'new-note' ? '…' : 'Add note'}
            </button>
          </form>
        )}

        <div className="mt-4 flex flex-col gap-3">
          {customer.notes.length === 0 && (
            <p className="text-sm text-[var(--color-muted)]">Nothing recorded yet.</p>
          )}
          {customer.notes.map((entry) => (
            <article
              key={entry.id}
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <p className="whitespace-pre-wrap text-sm">{entry.body}</p>
              <p className="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs text-[var(--color-muted)]">
                <span>
                  {/* Null when the author has left. The note still stands. */}
                  {entry.authorName ?? 'Former colleague'} ·{' '}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                {entry.authorMembershipId === membershipId && canWrite && (
                  <button
                    disabled={busy !== null}
                    onClick={() => send(`${base}/notes/${entry.id}`, 'DELETE', undefined, entry.id)}
                    className="underline underline-offset-4 disabled:opacity-50"
                  >
                    delete
                  </button>
                )}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function formatField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  return String(value);
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-[var(--color-line)] py-3 last:border-0">
      <dt className="text-sm text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right font-mono text-sm">{value ?? '—'}</dd>
    </div>
  );
}
