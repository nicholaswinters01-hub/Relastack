'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  forgotPasswordRequestSchema,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_TTL_MINUTES,
  resetPasswordRequestSchema,
} from '@platform/shared';
import { Field } from './auth-form';

const buttonClass =
  'mt-2 rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90 disabled:opacity-50';

function Shell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{intro}</p>
      {children}
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Remembered it?{' '}
        <Link
          href="/login"
          className="font-medium text-[var(--color-ink)] underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]"
    >
      {children}
    </p>
  );
}

/** Ask for a link. The page says the same thing whether or not the address has an account. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter your email address');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/auth/password/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 429) {
        setError('Too many requests. Wait a while and try again.');
      } else if (!response.ok) {
        setError('Something went wrong. Please try again.');
      } else {
        setSent(true);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Shell
        title="Check your email"
        intro={`If ${email} has an account, we have sent it a link to choose a new password. The link works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes.`}
      >
        <p className="mt-6 text-sm text-[var(--color-muted)]">
          Nothing after a few minutes? Check your spam folder, or{' '}
          <button
            type="button"
            onClick={() => setSent(false)}
            className="font-medium text-[var(--color-ink)] underline underline-offset-4"
          >
            try again
          </button>
          .
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Forgot your password?" intro="Enter your email and we will send you a link.">
      <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={submitting} className={buttonClass}>
          {submitting ? 'Sending…' : 'Send me a link'}
        </button>
      </form>
    </Shell>
  );
}

/** Choose a new password from an emailed link. */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Take the token out of the address bar, so it is not left in browser
  // history or shared by copying the URL. It stays in memory for the submit.
  useEffect(() => {
    window.history.replaceState(null, '', '/reset-password');
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFieldError(null);
    setError(null);

    if (password !== confirm) {
      setFieldError('The two passwords do not match');
      return;
    }

    const parsed = resetPasswordRequestSchema.safeParse({ token, password });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Choose a longer password');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });

      if (response.ok) {
        router.push('/login?reset=1');
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (response.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (Array.isArray(body.errors) && body.errors[0]?.message) {
        setFieldError(body.errors[0].message);
      } else {
        setError(body.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell
      title="Choose a new password"
      intro="Every device signed in to your account will be signed out."
    >
      <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4">
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          error={fieldError ?? undefined}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          required
        />
        <Field
          label="New password again"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          required
        />
        {error && (
          <Alert>
            {error}{' '}
            <Link href="/forgot-password" className="underline underline-offset-4">
              Get a new link
            </Link>
          </Alert>
        )}
        <button type="submit" disabled={submitting} className={buttonClass}>
          {submitting ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </Shell>
  );
}
