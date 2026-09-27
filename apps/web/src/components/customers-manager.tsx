'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  ASSIGNABLE_STAGES,
  type Customer,
  type CustomerStage,
  type Location,
  type Tag,
} from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

interface Props {
  customers: Customer[];
  tags: Tag[];
  locations: Location[];
  canWrite: boolean;
  activeSearch: string;
  activeStage: CustomerStage | null;
  activeTagId: string | null;
}

const STAGE_LABEL: Record<CustomerStage, string> = {
  LEAD: 'Lead',
  ACTIVE: 'Customer',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

/**
 * The customer list.
 *
 * The filters here narrow what is DISPLAYED. What the caller is allowed to see
 * was already decided by the server: a Location Manager searching for a
 * customer at another branch gets nothing back, because the query is scoped
 * before it runs — not because this component hides the row.
 */
export function CustomersManager({
  customers,
  tags,
  locations,
  canWrite,
  activeSearch,
  activeStage,
  activeTagId,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const [search, setSearch] = useState(activeSearch);
  // ?new=1 opens the form straight away: quick search's "New customer" lands here.
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(next: Record<string, string | null>) {
    const query = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') query.delete(key);
      else query.set(key, value);
    }

    router.push(`/customers?${query.toString()}`);
  }

  async function create(form: FormData) {
    setBusy(true);
    setError(null);

    const locationId = String(form.get('locationId') ?? '');
    const type = String(form.get('type') ?? 'PERSON');

    try {
      const response = await apiWrite('/api/v1/customers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          companyName: type === 'COMPANY' ? String(form.get('companyName') ?? '') : undefined,
          firstName: type === 'PERSON' ? String(form.get('firstName') ?? '') : undefined,
          lastName: type === 'PERSON' ? String(form.get('lastName') ?? '') : undefined,
          email: String(form.get('email') ?? ''),
          phone: String(form.get('phone') ?? ''),
          source: String(form.get('source') ?? ''),
          locationId: locationId === '' ? null : locationId,
        }),
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.errors?.[0]?.message ?? body.message ?? 'Could not create that customer');
        return;
      }

      setCreating(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply({ search });
          }}
          className="flex flex-1 gap-2"
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, email or phone"
            className="min-w-48 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs font-medium"
          >
            Search
          </button>
        </form>

        {canWrite && (
          <button
            onClick={() => setCreating((value) => !value)}
            className="rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)]"
          >
            {creating ? 'Cancel' : 'Add customer'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip
          label="All"
          active={activeStage === null}
          onClick={() => apply({ stage: null })}
        />
        {ASSIGNABLE_STAGES.map((stage) => (
          <FilterChip
            key={stage}
            label={STAGE_LABEL[stage]}
            active={activeStage === stage}
            onClick={() => apply({ stage })}
          />
        ))}
        {tags.map((tag) => (
          <FilterChip
            key={tag.id}
            label={`#${tag.name}`}
            active={activeTagId === tag.id}
            onClick={() => apply({ tagId: activeTagId === tag.id ? null : tag.id })}
          />
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {creating && (
        <form
          action={create}
          className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="type" value="PERSON" defaultChecked /> A person
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="type" value="COMPANY" /> A business
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="firstName" label="First name" />
            <Field name="lastName" label="Last name" />
            <Field name="companyName" label="Company name (if a business)" />
            <Field name="email" label="Email" type="email" />
            <Field name="phone" label="Phone" />
            <Field name="source" label="Where did they come from?" />

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Location</span>
              <select
                name="locationId"
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
              >
                <option value="">Not assigned</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="self-start rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy ? '…' : 'Create'}
          </button>
        </form>
      )}

      {/* ---------------------------------------------------------------- */}
      {customers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
          No customers match. Anything at a location you do not work at is not shown.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {customers.map((customer) => (
            <Link
              key={customer.id}
              href={`/customers/${customer.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-ink)]"
            >
              <div className="min-w-56 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="font-semibold">{customer.displayName}</h3>
                  <span className="font-mono text-xs text-[var(--color-muted)]">
                    {STAGE_LABEL[customer.stage].toLowerCase()}
                  </span>
                  {customer.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs"
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {[customer.email, customer.phone].filter(Boolean).join(' · ') ||
                    'No contact details'}
                </p>
              </div>

              <span className="font-mono text-xs text-[var(--color-muted)]">
                {customer.locationName ?? 'unassigned'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
          : 'border-[var(--color-line)]'
      }`}
    >
      {label}
    </button>
  );
}

function Field({ name, label, type = 'text' }: { name: string; label: string; type?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--color-muted)]">{label}</span>
      <input
        name={name}
        type={type}
        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
      />
    </label>
  );
}
