'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { IntegrationsResponse } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

type Provider = IntegrationsResponse['providers'][number];

async function post(path: string) {
  try {
    const response = await apiWrite(path, { method: 'POST' });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    return { ok: response.ok, payload };
  } catch {
    return { ok: false, payload: { message: 'Could not reach the server.' } };
  }
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function ProviderCard({ provider }: { provider: Provider }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const connection = provider.connection;

  async function connect() {
    setBusy('connect');
    setMessage(null);
    const result = await post(`/api/v1/integrations/${provider.key}/connect`);
    if (result.ok && result.payload.url) {
      // Off to the provider to approve; it sends the browser back here.
      window.location.assign(result.payload.url);
      return;
    }
    setBusy(null);
    setMessage(result.payload.message ?? 'That did not work.');
  }

  async function act(action: 'check' | 'disconnect') {
    if (
      action === 'disconnect' &&
      !window.confirm(
        `Disconnect ${provider.name}? RelaStack will stop sending from this account straight away.`,
      )
    ) {
      return;
    }
    setBusy(action);
    setMessage(null);
    const result = await post(`/api/v1/integrations/connections/${connection!.id}/${action}`);
    setBusy(null);
    if (!result.ok) {
      setMessage(result.payload.message ?? 'That did not work.');
      return;
    }
    setMessage(
      action === 'check'
        ? 'Working.'
        : provider.key === 'docusign'
          ? 'Disconnected. You can also remove RelaStack under Connected Apps in your DocuSign profile.'
          : 'Disconnected.',
    );
    router.refresh();
  }

  return (
    <li className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{provider.name}</p>
          <p className="mt-0.5 text-sm text-[var(--color-muted)]">{provider.description}</p>
          {connection && (
            <p className="mt-2 text-sm">
              {connection.status === 'CONNECTED' ? (
                <span className="text-[var(--color-ok)]">Connected</span>
              ) : (
                <span className="text-[var(--color-bad)]">Needs reconnecting</span>
              )}
              {' · '}
              {connection.accountName ?? connection.accountEmail}
              <span className="block text-xs text-[var(--color-muted)]">
                Connected by {connection.connectedByName} on {when(connection.connectedAt)}
                {connection.lastUsedAt && ` · last used ${when(connection.lastUsedAt)}`}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!provider.available ? (
            <span className="rounded-full border border-[var(--color-line)] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
              coming soon
            </span>
          ) : !connection || connection.status === 'NEEDS_RECONNECT' ? (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy !== null}
              className="rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy === 'connect'
                ? 'Opening…'
                : connection
                  ? 'Reconnect'
                  : `Connect ${provider.name}`}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void act('check')}
              disabled={busy !== null}
              className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm disabled:opacity-50"
            >
              {busy === 'check' ? 'Checking…' : 'Check'}
            </button>
          )}
          {connection && (
            <button
              type="button"
              onClick={() => void act('disconnect')}
              disabled={busy !== null}
              className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm text-[var(--color-bad)] disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
      {message && <p className="mt-3 text-sm">{message}</p>}
    </li>
  );
}

/**
 * The business's accounts in other services that RelaStack may act in.
 * Nothing secret is ever sent to the browser: only which account, and when.
 */
export function ConnectedApps({ data }: { data: IntegrationsResponse }) {
  return (
    <>
      <ul className="mt-6 flex flex-col gap-3">
        {data.providers.map((provider) => (
          <ProviderCard key={provider.key} provider={provider} />
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Recent activity
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Every time RelaStack connects to, uses or disconnects an account, it is written here.
        </p>
        {data.events.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">Nothing yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
            {data.events.map((event) => (
              <li key={event.id} className="flex flex-wrap justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  <span className="font-medium capitalize">{event.action}</span>
                  {event.detail && (
                    <span className="text-[var(--color-muted)]"> · {event.detail}</span>
                  )}
                </span>
                <span className="text-xs text-[var(--color-muted)]">
                  {event.actorName} · {when(event.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
