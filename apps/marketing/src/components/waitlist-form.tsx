'use client';

import { useState } from 'react';
import { BRAND } from '@/lib/brand';

type State = { status: 'idle' | 'sending' } | { status: 'done' | 'error'; message: string };

export function WaitlistForm() {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    setState({ status: 'sending' });

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          note: String(form.get('note') ?? '') || undefined,
          consent: form.get('consent') === 'on',
          company: String(form.get('company') ?? ''),
        }),
      });

      const body = await response.json().catch(() => ({}));

      setState({
        status: response.ok ? 'done' : 'error',
        message: body.message ?? 'Something went wrong. Please try again.',
      });
    } catch {
      setState({ status: 'error', message: 'Could not reach us. Check your connection.' });
    }
  }

  if (state.status === 'done') {
    return (
      <div className="rounded-2xl border border-[var(--color-ok)] bg-[var(--color-surface)] p-6">
        <p className="font-semibold text-[var(--color-ok)]">Thanks.</p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{state.message}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      /*
       * method and action matter even though the handler above normally takes
       * over. Without them a browser that has not hydrated yet — or has
       * JavaScript disabled — submits with GET, which puts the visitor's email
       * address in the URL, where every proxy and access log in the path
       * records it. With them, the worst case is a plain POST that the route
       * handler understands and answers with the thank-you page.
       */
      method="post"
      action="/api/waitlist"
      className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@yourbusiness.com"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2.5"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            What do you do? <span className="text-[var(--color-muted)]">(optional)</span>
          </span>
          <input
            name="note"
            maxLength={200}
            placeholder="Landscaping, two crews, one yard"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2.5"
          />
          <span className="text-xs text-[var(--color-muted)]">
            Genuinely useful — it decides what gets built first.
          </span>
        </label>

        {/*
          Honeypot. Hidden from people and from screen readers, but present in
          the DOM for anything filling every field it finds. Not display:none,
          which some bots now skip.
        */}
        <div className="absolute left-[-9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
          <label>
            Company
            <input name="company" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <label className="mt-1 flex items-start gap-2.5 text-sm">
          <input name="consent" type="checkbox" required className="mt-1" />
          <span className="text-[var(--color-muted)]">
            Email me about {BRAND.productName} — early access, and nothing else. Unsubscribe in one
            click, any time.
          </span>
        </label>

        {state.status === 'error' && (
          <p className="text-sm text-[var(--color-bad)]">{state.message}</p>
        )}

        <button
          type="submit"
          disabled={state.status === 'sending'}
          className="mt-1 rounded-lg border border-transparent bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {state.status === 'sending' ? 'Just a moment…' : 'Join the waitlist'}
        </button>
      </div>
    </form>
  );
}
