'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TAG_COLORS, type CustomFieldDefinition, type Tag } from '@platform/shared';

interface Props {
  tags: Tag[];
  fields: CustomFieldDefinition[];
}

const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT'] as const;

/**
 * The organization's own vocabulary.
 *
 * Both halves are the same idea: a business shapes the product to its trade
 * without anyone forking the code for them.
 */
export function CrmSettings({ tags, fields }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldType, setFieldType] = useState<string>('TEXT');

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

  return (
    <div className="mt-8 flex flex-col gap-10">
      {error && (
        <p className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Tags
        </h2>

        <div className="mt-3 flex flex-col gap-2">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <div>
                <p className="font-medium">{tag.name}</p>
                <p className="font-mono text-xs text-[var(--color-muted)]">
                  {tag.customerCount ?? 0} customer{tag.customerCount === 1 ? '' : 's'}
                </p>
              </div>

              <button
                disabled={busy !== null}
                onClick={() => send(`/api/v1/tags/${tag.id}`, 'DELETE', undefined, tag.id)}
                className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {busy === tag.id ? '…' : 'Delete'}
              </button>
            </div>
          ))}
        </div>

        <form
          className="mt-3 flex flex-wrap gap-2"
          action={async (form) => {
            await send(
              '/api/v1/tags',
              'POST',
              {
                name: String(form.get('name') ?? ''),
                color: String(form.get('color') ?? 'neutral'),
              },
              'new-tag',
            );
          }}
        >
          <input
            name="name"
            placeholder="New tag"
            required
            className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <select
            name="color"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            {TAG_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </section>

      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Custom fields
        </h2>

        <div className="mt-3 flex flex-col gap-2">
          {fields.length === 0 && (
            <p className="text-sm text-[var(--color-muted)]">None defined yet.</p>
          )}
          {fields.map((field) => (
            <div
              key={field.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
                field.archivedAt
                  ? 'border-dashed border-[var(--color-line)]'
                  : 'border-[var(--color-line)] bg-[var(--color-surface)]'
              }`}
            >
              <div>
                <p className="font-medium">
                  {field.label}
                  {field.isRequired && (
                    <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">
                      required
                    </span>
                  )}
                  {field.archivedAt && (
                    <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">
                      retired
                    </span>
                  )}
                </p>
                <p className="font-mono text-xs text-[var(--color-muted)]">
                  {field.key} · {field.type.toLowerCase()}
                  {field.options.length > 0 && ` · ${field.options.join(', ')}`}
                </p>
              </div>

              <button
                disabled={busy !== null}
                onClick={() =>
                  send(
                    field.archivedAt
                      ? `/api/v1/custom-fields/${field.id}/restore`
                      : `/api/v1/custom-fields/${field.id}`,
                    field.archivedAt ? 'POST' : 'DELETE',
                    undefined,
                    field.id,
                  )
                }
                className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {busy === field.id ? '…' : field.archivedAt ? 'Restore' : 'Retire'}
              </button>
            </div>
          ))}
        </div>

        <form
          className="mt-3 flex flex-col gap-2 rounded-xl border border-[var(--color-line)] p-4"
          action={async (form) => {
            const options = String(form.get('options') ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);

            await send(
              '/api/v1/custom-fields',
              'POST',
              {
                key: String(form.get('key') ?? ''),
                label: String(form.get('label') ?? ''),
                type: String(form.get('type') ?? 'TEXT'),
                options,
                isRequired: form.get('isRequired') === 'on',
              },
              'new-field',
            );
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              name="label"
              placeholder="Label, e.g. Gate code"
              required
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <input
              name="key"
              placeholder="Key, e.g. gate_code"
              required
              pattern="[a-z][a-z0-9_]*"
              title="Lower-case letters, numbers and underscores"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm"
            />
            <select
              name="type"
              value={fieldType}
              onChange={(event) => setFieldType(event.target.value)}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toLowerCase()}
                </option>
              ))}
            </select>
            <input
              name="options"
              placeholder="Choices, comma separated"
              disabled={fieldType !== 'SELECT'}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-40"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isRequired" /> Required
          </label>

          <p className="text-xs text-[var(--color-muted)]">
            The key is permanent. Changing it later would orphan every value already recorded, so
            only the label can be edited afterwards.
          </p>

          <button
            type="submit"
            disabled={busy !== null}
            className="self-start rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy === 'new-field' ? '…' : 'Add field'}
          </button>
        </form>
      </section>
    </div>
  );
}
