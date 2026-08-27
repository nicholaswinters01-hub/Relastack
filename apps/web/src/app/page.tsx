import { healthResponseSchema, type HealthResponse } from '@platform/shared';

// Phase 0 status page. Its only job is to prove the full stack is wired up:
// browser -> Next.js server -> API -> PostgreSQL. It is replaced by the real
// dashboard in Phase 10.

export const dynamic = 'force-dynamic';

type ProbeResult = { ok: true; data: HealthResponse } | { ok: false; reason: string };

async function probeApi(): Promise<ProbeResult> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

  try {
    const response = await fetch(`${baseUrl}/api/v1/health`, { cache: 'no-store' });
    const json = await response.json();

    // Validate against the shared contract rather than trusting the shape.
    const parsed = healthResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, reason: 'API responded, but the payload did not match the contract.' };
    }

    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, reason: `Could not reach the API at ${baseUrl}. Is it running?` };
  }
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const color =
    tone === 'ok' ? 'text-[var(--color-ok)]' : tone === 'bad' ? 'text-[var(--color-bad)]' : '';

  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-[var(--color-line)] py-3 last:border-0">
      <dt className="text-sm text-[var(--color-muted)]">{label}</dt>
      <dd className={`font-mono text-sm font-medium ${color}`}>{value}</dd>
    </div>
  );
}

export default async function StatusPage() {
  const probe = await probeApi();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Phase 0 — Project Setup
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Platform</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Foundation status. This page confirms the web application, the API, and the database are
        connected to one another.
      </p>

      <section className="mt-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          System status
        </h2>

        <dl className="mt-4">
          <Row label="Web application" value="running" tone="ok" />

          {probe.ok ? (
            <>
              <Row
                label="API"
                value={probe.data.status}
                tone={probe.data.status === 'ok' ? 'ok' : 'bad'}
              />
              <Row
                label="Database"
                value={probe.data.dependencies.database.status}
                tone={probe.data.dependencies.database.status === 'connected' ? 'ok' : 'bad'}
              />
              <Row
                label="Database latency"
                value={
                  probe.data.dependencies.database.latencyMs === null
                    ? '—'
                    : `${probe.data.dependencies.database.latencyMs} ms`
                }
              />
              <Row label="Environment" value={probe.data.environment} />
              <Row label="API uptime" value={`${probe.data.uptimeSeconds}s`} />
            </>
          ) : (
            <>
              <Row label="API" value="unreachable" tone="bad" />
              <Row label="Database" value="unknown" tone="bad" />
            </>
          )}
        </dl>

        {!probe.ok && (
          <p className="mt-4 rounded-lg bg-[var(--color-canvas)] p-3 text-sm text-[var(--color-bad)]">
            {probe.reason}
          </p>
        )}
      </section>

      <p className="mt-8 text-sm text-[var(--color-muted)]">
        All three rows green means Phase 0 is working end to end.
      </p>
    </main>
  );
}
