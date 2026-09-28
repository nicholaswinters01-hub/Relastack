'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MODULES, pestMemberFieldsSchema, type OrganizationMember } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm';

function LicenseRow({ member }: { member: OrganizationMember }) {
  const router = useRouter();
  const current = pestMemberFieldsSchema
    .catch({})
    .parse(member.packFields[MODULES.PEST_CONTROL] ?? {});
  const [number, setNumber] = useState(current.licenseNumber ?? '');
  const [expires, setExpires] = useState(current.licenseExpiresOn ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed =
    number !== (current.licenseNumber ?? '') || expires !== (current.licenseExpiresOn ?? '');
  const expired =
    current.licenseExpiresOn !== undefined &&
    current.licenseExpiresOn !== null &&
    current.licenseExpiresOn < new Date().toISOString().slice(0, 10);
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const response = await apiWrite(
        `/api/v1/organizations/current/members/${member.membershipId}/pack-fields`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            packFields: {
              [MODULES.PEST_CONTROL]: { licenseNumber: number, licenseExpiresOn: expires || null },
            },
          }),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-end justify-between gap-3 px-4 py-3">
      <div className="min-w-40">
        <p className="text-sm font-medium">{name}</p>
        {expired && <p className="text-xs text-[var(--color-bad)]">License expired</p>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          License number
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className={`${FIELD} w-36`}
            maxLength={40}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Expires
          <input
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            className={FIELD}
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !changed}
          className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-40"
        >
          {busy ? '…' : 'Save'}
        </button>
      </div>
      {error && <p className="w-full text-sm text-[var(--color-bad)]">{error}</p>}
    </li>
  );
}

/**
 * Applicator licenses, with the Pest Control pack. Each treatment copies the
 * applicator's license as it is on the day, so renewing one here never
 * changes a record already made.
 */
export function ApplicatorLicenses({ members }: { members: OrganizationMember[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Applicator licenses
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Printed on every application record the person makes. Changing one here does not change
        records already made.
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
        {members.map((member) => (
          <LicenseRow key={member.membershipId} member={member} />
        ))}
      </ul>
    </section>
  );
}
