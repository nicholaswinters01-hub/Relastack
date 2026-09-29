'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  Contract,
  ContractTemplate,
  ContractTemplatesResponse,
  TemplateDetail,
} from '@platform/shared';
import { CONTRACT_STATUS } from '@/lib/contract-labels';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';
const LABEL = 'flex flex-col gap-1 text-xs text-[var(--color-muted)]';

/** What the customer record can fill in a template, by how fields are usually labelled. */
export interface ContractPrefill {
  name: string;
  email: string;
  phone: string;
  address: string;
  accountNumber: string;
}

const normalise = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '');
const PREFILL_LABELS: Record<string, keyof ContractPrefill> = {
  name: 'name',
  customername: 'name',
  clientname: 'name',
  fullname: 'name',
  customer: 'name',
  client: 'name',
  email: 'email',
  customeremail: 'email',
  emailaddress: 'email',
  phone: 'phone',
  phonenumber: 'phone',
  address: 'address',
  serviceaddress: 'address',
  propertyaddress: 'address',
  customeraddress: 'address',
  accountnumber: 'accountNumber',
  account: 'accountNumber',
  accountno: 'accountNumber',
};

async function fetchJson<T>(path: string): Promise<{ data?: T; error?: string }> {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { error: payload.message ?? 'That did not work.' };
    return { data: payload as T };
  } catch {
    return { error: 'Could not reach the server.' };
  }
}

async function post(path: string, body: unknown) {
  try {
    const response = await apiWrite(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok
      ? { ok: true as const, payload }
      : {
          ok: false as const,
          message: payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.',
        };
  } catch {
    return { ok: false as const, message: 'Could not reach the server.' };
  }
}

function SendForm({
  customerId,
  prefill,
  canConnect,
  onDone,
}: {
  customerId: string;
  prefill: ContractPrefill;
  canConnect: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState<ContractTemplatesResponse | null>(null);
  const [chosen, setChosen] = useState<ContractTemplate | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [role, setRole] = useState('');
  const [signerName, setSignerName] = useState(prefill.name);
  const [signerEmail, setSignerEmail] = useState(prefill.email);
  const [subject, setSubject] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Asked for when the form opens: listing templates is a call to DocuSign.
  useEffect(() => {
    let current = true;
    void fetchJson<ContractTemplatesResponse>('/api/v1/contracts/templates').then((result) => {
      if (!current) return;
      if (result.error) setError(result.error);
      else setTemplates(result.data!);
    });
    return () => {
      current = false;
    };
  }, []);

  async function choose(key: string) {
    const template =
      templates?.templates.find((t) => `${t.provider}:${t.templateId}` === key) ?? null;
    setChosen(template);
    setDetail(null);
    setError(null);
    if (!template) return;
    const result = await fetchJson<TemplateDetail>(
      `/api/v1/contracts/templates/${template.provider}/${encodeURIComponent(template.templateId)}`,
    );
    if (result.error) {
      setError(result.error);
      return;
    }
    const found = result.data!;
    setDetail(found);
    setRole(found.roles[0] ?? '');
    setSubject(found.name);
    setFields(
      Object.fromEntries(
        found.fields.map((label) => {
          const key = PREFILL_LABELS[normalise(label)];
          return [label, key ? prefill[key] : ''];
        }),
      ),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !detail) return;
    setError(null);
    setBusy(true);
    const result = await post('/api/v1/contracts', {
      customerId,
      provider: chosen.provider,
      templateId: chosen.templateId,
      roleName: role,
      signerName,
      signerEmail,
      subject,
      fields,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
    onDone();
  }

  if (templates && !templates.connected) {
    return (
      <div className="mt-3 rounded-lg border border-[var(--color-line)] p-4 text-sm">
        {canConnect ? (
          <>
            Connect your DocuSign first.{' '}
            <Link href="/settings/connected-apps" className="underline underline-offset-4">
              Settings → Connected apps
            </Link>
          </>
        ) : (
          'No e-signature account is connected yet. An owner or admin can connect one under Settings.'
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 flex flex-col gap-3 rounded-lg border border-[var(--color-line)] p-4"
    >
      {!templates ? (
        <p className="text-sm text-[var(--color-muted)]">{error ?? 'Loading your templates…'}</p>
      ) : templates.templates.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Your DocuSign has no templates yet. Make one in DocuSign (Templates → New), then come
          back.
        </p>
      ) : (
        <>
          <label className={LABEL}>
            Template
            <select
              value={chosen ? `${chosen.provider}:${chosen.templateId}` : ''}
              onChange={(e) => void choose(e.target.value)}
              className={FIELD}
            >
              <option value="">Choose a template…</option>
              {templates.templates.map((template) => (
                <option
                  key={`${template.provider}:${template.templateId}`}
                  value={`${template.provider}:${template.templateId}`}
                >
                  {template.name}
                </option>
              ))}
            </select>
          </label>

          {detail && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={LABEL}>
                  Signer&apos;s name
                  <input
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    className={FIELD}
                    required
                    maxLength={100}
                  />
                </label>
                <label className={LABEL}>
                  Signer&apos;s email
                  <input
                    type="email"
                    value={signerEmail}
                    onChange={(e) => setSignerEmail(e.target.value)}
                    className={FIELD}
                    required
                  />
                </label>
                {detail.roles.length > 1 && (
                  <label className={LABEL}>
                    They sign as
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className={FIELD}
                    >
                      {detail.roles.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={`${LABEL} sm:col-span-2`}>
                  Email subject
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className={FIELD}
                    maxLength={100}
                  />
                </label>
              </div>
              {detail.fields.length > 0 && (
                <fieldset className="grid gap-3 sm:grid-cols-2">
                  <legend className="mb-1 text-xs font-semibold text-[var(--color-muted)]">
                    Fields in the template
                  </legend>
                  {detail.fields.map((label) => (
                    <label key={label} className={LABEL}>
                      {label}
                      <input
                        value={fields[label] ?? ''}
                        onChange={(e) => setFields({ ...fields, [label]: e.target.value })}
                        className={FIELD}
                        maxLength={500}
                      />
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !detail || !role}
              className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send for signature'}
            </button>
            <button
              type="button"
              onClick={onDone}
              className="px-3 text-sm underline underline-offset-4"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function ContractRow({ contract }: { contract: Contract }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = CONTRACT_STATUS[contract.status];
  const open = contract.status === 'SENT' || contract.status === 'VIEWED';

  async function act(action: 'check' | 'void') {
    let body: unknown = {};
    if (action === 'void') {
      const reason = window.prompt(
        'Why is this contract being withdrawn? The customer will no longer be able to sign it.',
      );
      if (!reason?.trim()) return;
      body = { reason: reason.trim() };
    }
    setBusy(true);
    setError(null);
    const result = await post(`/api/v1/contracts/${contract.id}/${action}`, body);
    setBusy(false);
    if (!result.ok) setError(result.message);
    else router.refresh();
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{contract.title}</p>
          <p className="text-xs text-[var(--color-muted)]">
            To {contract.signerName} ({contract.signerEmail}) · sent by {contract.sentByName} on{' '}
            {new Date(contract.sentAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${status.tone}`}
        >
          {status.label}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {open && (
          <button
            type="button"
            onClick={() => void act('check')}
            disabled={busy}
            className="underline underline-offset-4"
          >
            Check status
          </button>
        )}
        {contract.status === 'SIGNED' && (
          <a
            href={`/api/v1/contracts/${contract.id}/document`}
            target="_blank"
            rel="noopener"
            className="underline underline-offset-4"
          >
            View signed copy
          </a>
        )}
        {open && contract.canManage && (
          <button
            type="button"
            onClick={() => void act('void')}
            disabled={busy}
            className="text-[var(--color-bad)] underline underline-offset-4"
          >
            Withdraw
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-sm text-[var(--color-bad)]">{error}</p>}
    </li>
  );
}

/**
 * Contracts on the customer's page: what was sent, where each stands, and
 * sending another. The documents stay in the business's DocuSign.
 */
export function CustomerContracts({
  customerId,
  contracts,
  canSend,
  canConnect,
  prefill,
}: {
  customerId: string;
  contracts: Contract[];
  canSend: boolean;
  canConnect: boolean;
  prefill: ContractPrefill;
}) {
  const [sending, setSending] = useState(false);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Contracts
        </h2>
        {canSend && !sending && (
          <button
            type="button"
            onClick={() => setSending(true)}
            className="text-sm underline underline-offset-4"
          >
            Send a contract
          </button>
        )}
      </div>
      {sending && (
        <SendForm
          customerId={customerId}
          prefill={prefill}
          canConnect={canConnect}
          onDone={() => setSending(false)}
        />
      )}
      {contracts.length === 0 ? (
        !sending && <p className="mt-2 text-sm text-[var(--color-muted)]">Nothing sent yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          {contracts.map((contract) => (
            <ContractRow key={contract.id} contract={contract} />
          ))}
        </ul>
      )}
    </section>
  );
}
