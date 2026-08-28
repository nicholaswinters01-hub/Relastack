'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { loginRequestSchema, registerRequestSchema, PASSWORD_MIN_LENGTH } from '@platform/shared';

type Mode = 'login' | 'register';

interface FieldError {
  field: string;
  message: string;
}

/**
 * Shared sign-in / sign-up form.
 *
 * Validates with the same Zod schemas the API uses, so the user gets immediate
 * feedback without a round trip. This is a convenience, never a control — the
 * server validates independently and is the only opinion that counts.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const isRegister = mode === 'register';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    setFormError(null);

    const payload = isRegister
      ? { email, password, firstName, lastName, organizationName }
      : { email, password };
    const schema = isRegister ? registerRequestSchema : loginRequestSchema;
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      setErrors(
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      );
      return;
    }

    setSubmitting(true);

    try {
      // Relative URL: goes through the Next.js rewrite so the browser treats
      // the API as same-origin and keeps the session cookie.
      const response = await fetch(`/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });

      if (response.ok) {
        router.push('/account');
        router.refresh();
        return;
      }

      const body = await response.json().catch(() => ({}));

      if (response.status === 429) {
        setFormError('Too many attempts. Wait a minute and try again.');
      } else if (Array.isArray(body.errors)) {
        setErrors(body.errors);
      } else {
        setFormError(body.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setFormError('Could not reach the server. Is the API running?');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        {isRegister ? 'Create your account' : 'Sign in'}
      </h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {isRegister
          ? 'Sets up your business. You can invite your team once roles arrive in Phase 4.'
          : 'Welcome back.'}
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-4">
        {isRegister && (
          <Field
            label="Business name"
            value={organizationName}
            onChange={setOrganizationName}
            autoComplete="organization"
            error={errorFor('organizationName')}
            hint="You will be its owner."
            required
          />
        )}

        {isRegister && (
          <div className="flex gap-3">
            <Field
              label="First name"
              value={firstName}
              onChange={setFirstName}
              autoComplete="given-name"
              error={errorFor('firstName')}
            />
            <Field
              label="Last name"
              value={lastName}
              onChange={setLastName}
              autoComplete="family-name"
              error={errorFor('lastName')}
            />
          </div>
        )}

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          error={errorFor('email')}
          required
        />

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          error={errorFor('password')}
          hint={isRegister ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
          required
        />

        {formError && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]"
          >
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-2 rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-[var(--color-muted)]">
        {isRegister ? 'Already have an account? ' : 'No account yet? '}
        <Link
          href={isRegister ? '/login' : '/register'}
          className="font-medium text-[var(--color-ink)] underline underline-offset-4"
        >
          {isRegister ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </main>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  error?: string;
  hint?: string;
  required?: boolean;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  error,
  hint,
  required,
}: FieldProps) {
  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        className={`rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--color-ink)]/20 ${
          error ? 'border-[var(--color-bad)]' : 'border-[var(--color-line)]'
        }`}
      />
      {error ? (
        <span className="text-xs text-[var(--color-bad)]">{error}</span>
      ) : hint ? (
        <span className="text-xs text-[var(--color-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
