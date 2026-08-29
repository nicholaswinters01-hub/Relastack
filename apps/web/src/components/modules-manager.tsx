'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ModuleState } from '@platform/shared';

interface Props {
  modules: ModuleState[];
  canManage: boolean;
}

/**
 * Module switches.
 *
 * Hiding a switch the user cannot operate is a courtesy. What actually stops a
 * disabled module being used is the guard on the API — the e2e suite asserts
 * that calling a gated endpoint directly still returns 403 with
 * MODULE_NOT_ENABLED.
 */
export function ModulesManager({ modules, canManage }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameFor = (key: string) => modules.find((m) => m.key === key)?.name ?? key;

  async function toggle(module: ModuleState) {
    setBusy(module.key);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch(`/api/v1/modules/${module.key}`, {
        method: module.enabled ? 'DELETE' : 'POST',
        credentials: 'include',
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.message ?? 'Could not change that module');
        return;
      }

      // Dependencies are enabled automatically, so say which — a silent extra
      // change to what the customer is billed for would be worse than useless.
      const alsoEnabled: string[] = (body.enabled ?? []).filter(
        (key: string) => key !== module.key,
      );

      if (alsoEnabled.length > 0) {
        setMessage(
          `${module.name} needs ${alsoEnabled.map(nameFor).join(' and ')}, so ${
            alsoEnabled.length === 1 ? 'it was' : 'they were'
          } turned on too.`,
        );
      }

      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-8 flex flex-col gap-3">
      {(message || error) && (
        <p
          className={`rounded-lg bg-[var(--color-surface)] p-3 text-sm ${
            error ? 'text-[var(--color-bad)]' : 'text-[var(--color-muted)]'
          }`}
        >
          {error ?? message}
        </p>
      )}

      {modules.map((module) => (
        <div
          key={module.key}
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <div className="min-w-64 flex-1">
            <div className="flex items-baseline gap-2">
              <h3 className="font-semibold">{module.name}</h3>
              {module.isCore && (
                <span className="font-mono text-xs text-[var(--color-muted)]">always on</span>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{module.description}</p>
            {module.dependencies.length > 0 && (
              <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">
                requires {module.dependencies.map(nameFor).join(', ')}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`font-mono text-xs ${
                module.enabled ? 'text-[var(--color-ok)]' : 'text-[var(--color-muted)]'
              }`}
            >
              {module.enabled ? 'enabled' : module.entitled ? 'off' : 'not in your plan'}
            </span>

            {/* Two different messages, not one greyed-out button: "you have
                this and chose not to use it" and "this costs more" are
                different situations for a customer. */}
            {canManage &&
              !module.isCore &&
              (module.entitled ? (
                <button
                  onClick={() => toggle(module)}
                  disabled={busy !== null}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                    module.enabled
                      ? 'border-[var(--color-line)]'
                      : 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                  }`}
                >
                  {busy === module.key ? '…' : module.enabled ? 'Turn off' : 'Turn on'}
                </button>
              ) : (
                <Link
                  href="/billing"
                  className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium"
                >
                  Upgrade
                </Link>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
