'use client';

import Link from 'next/link';
import { useState, type ChangeEvent } from 'react';
import {
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  customerImportPreviewSchema,
  customerImportResultSchema,
  type CustomFieldDefinition,
  type CustomerImportPreview,
  type CustomerImportResult,
  type ImportRow,
  type Location,
} from '@platform/shared';
import { guessField, parseCsv, type ParsedCsv } from '@/lib/csv';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';
const BUTTON =
  'rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50';

/**
 * Bringing a customer list in from a spreadsheet.
 *
 * The file is read here, in the browser, and never uploaded as a file: only
 * the matched rows go to the server, which checks each one with the same rules
 * as adding a customer by hand. Nothing is saved until the preview has been
 * seen and "Import" pressed.
 */
export function CustomerImporter({
  locations,
  customFields,
  canChooseNumbers,
}: {
  locations: Location[];
  customFields: CustomFieldDefinition[];
  canChooseNumbers: boolean;
}) {
  const [file, setFile] = useState<{ name: string; csv: ParsedCsv } | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [locationId, setLocationId] = useState<string>(locations[0]?.id ?? '');
  const [stage, setStage] = useState<'ACTIVE' | 'LEAD'>('ACTIVE');
  const [preview, setPreview] = useState<CustomerImportPreview | null>(null);
  const [result, setResult] = useState<CustomerImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveCustomFields = customFields.filter((field) => field.archivedAt === null);
  const targets = [
    ...IMPORT_FIELDS.filter((f) => f.key !== 'accountNumber' || canChooseNumbers).map((f) => ({
      value: f.key as string,
      label: f.label,
    })),
    ...liveCustomFields.map((f) => ({ value: `custom:${f.key}`, label: `${f.label} (custom)` })),
  ];

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setPreview(null);
    setResult(null);
    const chosen = event.target.files?.[0];
    if (!chosen) return;

    if (!/\.(csv|txt)$/i.test(chosen.name)) {
      setError('Choose a .csv file. In Excel or Google Sheets: File → Save as / Download → CSV.');
      return;
    }
    const csv = parseCsv(await chosen.text());
    if (csv.headers.length === 0 || csv.rows.length === 0) {
      setError('That file has no rows under its header line.');
      return;
    }
    if (csv.rows.length > IMPORT_MAX_ROWS) {
      setError(
        `That file has ${csv.rows.length} rows. Up to ${IMPORT_MAX_ROWS} per import: split it into smaller files.`,
      );
      return;
    }

    // One field per column: the first column to claim a field keeps it.
    const used = new Set<string>();
    const guessed = csv.headers.map((header) => {
      const guess = guessField(header, liveCustomFields);
      const allowed = guess && (guess !== 'accountNumber' || canChooseNumbers);
      if (!allowed || used.has(guess!)) return '';
      used.add(guess!);
      return guess!;
    });

    setFile({ name: chosen.name, csv });
    setMapping(guessed);
  }

  function rows(): ImportRow[] {
    if (!file) return [];
    return file.csv.rows.map((cells) => {
      const row: ImportRow = {};
      const custom: Record<string, string> = {};
      mapping.forEach((target, column) => {
        const value = cells[column] ?? '';
        if (!target || value.trim() === '') return;
        if (target.startsWith('custom:')) custom[target.slice(7)] = value;
        else (row as Record<string, string>)[target] = value;
      });
      if (Object.keys(custom).length > 0) row.customFields = custom;
      return row;
    });
  }

  async function post(path: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await apiWrite(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: locationId || null, stage, rows: rows() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return null;
      }
      return payload;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  const nameMapped = mapping.some(
    (t) => t === 'firstName' || t === 'lastName' || t === 'companyName',
  );

  if (result) {
    return (
      <section className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h2 className="text-xl font-semibold">
          Imported {result.created} customer{result.created === 1 ? '' : 's'}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {result.skippedDuplicates > 0 &&
            `${result.skippedDuplicates} already existed and ${result.skippedDuplicates === 1 ? 'was' : 'were'} skipped. `}
          {result.skippedInvalid > 0 &&
            `${result.skippedInvalid} had problems and ${result.skippedInvalid === 1 ? 'was' : 'were'} skipped. `}
          {result.tag &&
            `Everyone imported is tagged “${result.tag.name}”, so if something went wrong you can find them all and remove them.`}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {result.tag && (
            <Link href={`/customers?tagId=${result.tag.id}`} className={BUTTON}>
              See who was imported
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setFile(null);
              setPreview(null);
            }}
            className="text-sm underline underline-offset-4"
          >
            Import another file
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          1. Choose a file
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          A .csv with one customer per line and column names on the first line. Excel and Google
          Sheets can both save one. Up to {IMPORT_MAX_ROWS} customers per file.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={choose} className="mt-4 text-sm" />
        {file && (
          <p className="mt-2 text-sm">
            {file.name}: {file.csv.rows.length} row{file.csv.rows.length === 1 ? '' : 's'}
          </p>
        )}
      </section>

      {file && (
        <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            2. Match the columns
          </h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            We guessed from the column names. Change any that are wrong; leave a column on
            “Don&apos;t import” to skip it.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="py-2 pr-4 font-medium">Column in your file</th>
                  <th className="py-2 pr-4 font-medium">First row</th>
                  <th className="py-2 font-medium">Goes into</th>
                </tr>
              </thead>
              <tbody>
                {file.csv.headers.map((header, column) => (
                  <tr key={column} className="border-t border-[var(--color-line)]">
                    <td className="py-2 pr-4 font-medium">{header || `Column ${column + 1}`}</td>
                    <td className="max-w-48 truncate py-2 pr-4 text-[var(--color-muted)]">
                      {file.csv.rows[0]?.[column] ?? ''}
                    </td>
                    <td className="py-2">
                      <select
                        value={mapping[column] ?? ''}
                        onChange={(event) => {
                          setPreview(null);
                          const next = [...mapping];
                          next[column] = event.target.value;
                          setMapping(next);
                        }}
                        aria-label={`Field for ${header}`}
                        className={FIELD}
                      >
                        <option value="">Don&apos;t import</option>
                        {targets.map((target) => (
                          <option
                            key={target.value}
                            value={target.value}
                            disabled={
                              mapping.includes(target.value) && mapping[column] !== target.value
                            }
                          >
                            {target.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!nameMapped && (
            <p className="mt-3 text-sm text-[var(--color-bad)]">
              Match at least one name column (first name, last name or company name).
            </p>
          )}

          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            3. Where they go
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">Location</span>
              <select
                value={locationId}
                onChange={(event) => {
                  setPreview(null);
                  setLocationId(event.target.value);
                }}
                className={FIELD}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
                <option value="">No location (whole business)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">Import them as</span>
              <select
                value={stage}
                onChange={(event) => {
                  setPreview(null);
                  setStage(event.target.value as 'ACTIVE' | 'LEAD');
                }}
                className={FIELD}
              >
                <option value="ACTIVE">Customers</option>
                <option value="LEAD">Leads</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            disabled={busy || !nameMapped}
            onClick={async () => {
              const payload = await post('/api/v1/customers/import/preview');
              const parsed = customerImportPreviewSchema.safeParse(payload);
              if (parsed.success) setPreview(parsed.data);
            }}
            className={`${BUTTON} mt-6`}
          >
            {busy && !preview ? 'Checking…' : 'Check the file'}
          </button>
        </section>
      )}

      {file && preview && (
        <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            4. Check and import
          </h2>
          <p className="mt-3 text-sm">
            <strong>{preview.counts.ready}</strong> ready to import ·{' '}
            <strong>{preview.counts.duplicate}</strong> already exist (skipped) ·{' '}
            <strong>{preview.counts.invalid}</strong> with problems (skipped)
          </p>

          {preview.rows.some((row) => row.status !== 'ready') && (
            <ul className="mt-4 flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
              {preview.rows
                .filter((row) => row.status !== 'ready')
                .map((row) => (
                  <li key={row.index} className="rounded-lg bg-[var(--color-canvas)] p-3">
                    <span className="font-medium">Row {row.index + 2}</span>{' '}
                    {row.status === 'duplicate' ? (
                      <span className="text-[var(--color-muted)]">
                        already exists:{' '}
                        {row.duplicateOf?.customerId ? (
                          <Link
                            href={`/customers/${row.duplicateOf.customerId}`}
                            className="underline underline-offset-4"
                          >
                            {row.duplicateOf.displayName}
                            {row.duplicateOf.accountNumber !== null &&
                              ` #${row.duplicateOf.accountNumber}`}
                          </Link>
                        ) : (
                          `same person as row ${(row.duplicateOf?.row ?? 0) + 1} of this file`
                        )}
                      </span>
                    ) : (
                      <span className="text-[var(--color-bad)]">{row.errors.join(' · ')}</span>
                    )}
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Row numbers match your spreadsheet, counting the header as row 1.
          </p>

          <button
            type="button"
            disabled={busy || preview.counts.ready === 0}
            onClick={async () => {
              const payload = await post('/api/v1/customers/import');
              const parsed = customerImportResultSchema.safeParse(payload);
              if (parsed.success) setResult(parsed.data);
            }}
            className={`${BUTTON} mt-6`}
          >
            {busy
              ? 'Importing…'
              : `Import ${preview.counts.ready} customer${preview.counts.ready === 1 ? '' : 's'}`}
          </button>
        </section>
      )}

      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
    </div>
  );
}
