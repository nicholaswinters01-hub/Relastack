import { NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  createSessionToken,
  isAdminConfigured,
  isSameOrigin,
  sessionCookieOptions,
  verifyCredentials,
} from '@/lib/admin-auth';

export const runtime = 'nodejs';

/**
 * Failed attempts per address, in memory.
 *
 * Resets on deploy and does not span instances, so it slows a guesser rather
 * than stopping a determined one. The real protection is the password itself
 * (the setup script requires 12+ characters) and scrypt making every guess
 * expensive.
 */
const FAILURES = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function lockedOut(ip: string, now: number): boolean {
  const entry = FAILURES.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= now) {
    FAILURES.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip: string, now: number): void {
  const entry = FAILURES.get(ip);

  if (!entry || entry.resetAt <= now) {
    if (FAILURES.size > 10_000) FAILURES.clear();
    FAILURES.set(ip, { count: 1, resetAt: now + LOCKOUT_MS });
  } else {
    entry.count += 1;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });

  // Only a short code ever goes in the URL — never the email that was typed.
  const back = (code: string) => {
    const url = new URL('/admin/login', request.url);
    url.searchParams.set('error', code);
    return NextResponse.redirect(url, 303);
  };

  if (!isAdminConfigured()) return back('unavailable');

  const now = Date.now();
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  if (lockedOut(ip, now)) return back('locked');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('invalid');
  }

  const email = String(form.get('email') ?? '').slice(0, 254);
  const password = String(form.get('password') ?? '');

  const admin =
    email && password && password.length <= 200 ? await verifyCredentials(email, password) : null;

  if (!admin) {
    recordFailure(ip, now);
    console.warn(`[admin] failed sign-in from ${ip}`);
    return back('invalid');
  }

  FAILURES.delete(ip);

  const response = NextResponse.redirect(new URL('/admin', request.url), 303);
  response.cookies.set(ADMIN_COOKIE, createSessionToken(admin), sessionCookieOptions());

  return response;
}
