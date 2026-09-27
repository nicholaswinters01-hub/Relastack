'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ACCOUNT_NUMBER_MAX, type CustomerDetail } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

async function send(path: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const response = await apiWrite(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.';
  } catch {
    return 'Could not reach the server.';
  }
}

/**
 * Editing a customer's details.
 *
 * Every box is sent, so emptying one clears it. The account number is only
 * offered to owners, who may set it to match a system they are leaving; the
 * API refuses anyone else and any number already in use.
 */
export function CustomerEditForm({
  customer,
  canRenumber,
  onDone,
}: {
  customer: CustomerDetail;
  canRenumber: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [type, setType] = useState(customer.type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');

    const body: Record<string, unknown> = {
      type,
      companyName: text('companyName'),
      firstName: text('firstName'),
      lastName: text('lastName'),
      email: text('email'),
      phone: text('phone'),
      addressLine1: text('addressLine1'),
      addressLine2: text('addressLine2'),
      city: text('city'),
      region: text('region'),
      postalCode: text('postalCode'),
      country: text('country'),
    };

    if (canRenumber) {
      const raw = text('accountNumber').replace('#', '').trim();
      const number = Number(raw);
      if (!/^\d+$/.test(raw) || number < 1 || number > ACCOUNT_NUMBER_MAX) {
        setError('The account number must be a whole number, like 1042.');
        return;
      }
      body.accountNumber = number;
    }

    setBusy(true);
    setError(null);
    const failure = await send(`/api/v1/customers/${customer.id}`, 'PATCH', body);
    setBusy(false);

    if (failure) {
      setError(failure);
      return;
    }
    router.refresh();
    onDone();
  }

  const input = (
    name: keyof CustomerDetail,
    label: string,
    props: Record<string, unknown> = {},
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      <input
        name={name}
        defaultValue={(customer[name] as string | null) ?? ''}
        className={FIELD}
        {...props}
      />
    </label>
  );

  return (
    <form onSubmit={save} className="mt-4 flex flex-col gap-4">
      <div className="flex gap-2" role="radiogroup" aria-label="Kind of customer">
        {(['PERSON', 'COMPANY'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={type === option}
            onClick={() => setType(option)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              type === option
                ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                : 'border-[var(--color-line)]'
            }`}
          >
            {option === 'PERSON' ? 'A person' : 'A company'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {type === 'COMPANY' && (
          <div className="sm:col-span-2">{input('companyName', 'Company name')}</div>
        )}
        {input('firstName', type === 'COMPANY' ? 'Contact first name' : 'First name')}
        {input('lastName', type === 'COMPANY' ? 'Contact last name' : 'Last name')}
        {input('email', 'Email', { type: 'email' })}
        {input('phone', 'Phone', { type: 'tel' })}
        <div className="sm:col-span-2">{input('addressLine1', 'Address')}</div>
        <div className="sm:col-span-2">{input('addressLine2', 'Address line 2')}</div>
        {input('city', 'City')}
        {input('region', 'State / region')}
        {input('postalCode', 'Postal code')}
        {input('country', 'Country')}
        {canRenumber && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[var(--color-muted)]">
              Account number (owners only — to match your old system)
            </span>
            <input
              name="accountNumber"
              defaultValue={customer.accountNumber}
              inputMode="numeric"
              className={FIELD}
            />
          </label>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone} className="text-sm underline underline-offset-4">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Removing a customer.
 *
 * "Remove" archives: hidden everywhere, history kept, undoable. Deleting for
 * good is a separate, owner-only step that asks for the name to be typed: it
 * takes the notes, contacts, jobs, recurring visits and tasks with it, and
 * cannot be undone.
 */
export function CustomerRemoval({
  customer,
  canWrite,
  canDelete,
}: {
  customer: CustomerDetail;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/v1/customers/${customer.id}`;
  const archived = customer.stage === 'ARCHIVED';

  async function act(path: string, method: string, body?: unknown, then?: () => void) {
    setBusy(true);
    setError(null);
    const failure = await send(path, method, body);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (then) then();
    else router.refresh();
  }

  if (!canWrite && !canDelete) return null;

  return (
    <section className="rounded-xl border border-[var(--color-line)] p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        {archived ? 'Archived' : 'Remove'}
      </h2>

      {canWrite &&
        (archived ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-[var(--color-muted)]">
              Hidden from lists and search results; nothing was deleted.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(base, 'PATCH', { stage: 'ACTIVE' })}
              className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Restore as a customer
            </button>
          </div>
        ) : confirmingArchive ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span>
              Remove {customer.displayName}? They are hidden from lists; notes and history are kept,
              and you can restore them.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(base, 'DELETE')}
              className="rounded-lg bg-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Removing…' : 'Remove'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingArchive(false)}
              className="text-xs underline underline-offset-4"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingArchive(true)}
            className="mt-3 rounded-lg border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]"
          >
            Remove customer
          </button>
        ))}

      {canDelete && (
        <div className="mt-5 border-t border-[var(--color-line)] pt-4">
          {confirmingDelete ? (
            <div className="flex flex-col gap-2 text-sm">
              <span>
                This deletes {customer.displayName} for good, and everything attached to them:
                notes, contacts, every job past and upcoming, recurring visits, and tasks. It cannot
                be undone. To keep the history, use Remove instead.
              </span>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-muted)]">
                  Type <strong>{customer.displayName}</strong> to confirm
                </span>
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  className={FIELD}
                  autoComplete="off"
                />
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy || typed.trim() !== customer.displayName}
                  onClick={() =>
                    void act(`${base}/permanent`, 'DELETE', undefined, () =>
                      router.push('/customers'),
                    )
                  }
                  className="rounded-lg bg-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy ? 'Deleting…' : 'Delete for good'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingDelete(false);
                    setTyped('');
                  }}
                  className="text-xs underline underline-offset-4"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="text-xs text-[var(--color-bad)] underline underline-offset-4"
            >
              Delete permanently (owners only)
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
    </section>
  );
}
