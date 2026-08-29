import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy, with a per-request nonce.
 *
 * The same approach as the product app, and for the same reason: a nonce is
 * unguessable and regenerated per request, so only scripts this server
 * actually emitted will run, and `strict-dynamic` lets those load their own
 * chunks.
 *
 * A flat `script-src 'self'` looks stricter and is worse. It blocks the inline
 * bootstrap Next.js emits, so React never hydrates — the page silently
 * degrades to no JavaScript at all, which is easy to miss because the markup
 * still renders. That happened here, and the console was the only sign.
 *
 * There is less at stake on a marketing page than in the product — no session,
 * no user data on screen — but the form does collect an email address, and
 * `form-action 'self'` is what stops injected markup pointing it elsewhere.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV === 'development';

  const policy = [
    `default-src 'self'`,
    // 'unsafe-eval' is required by the dev server's hot reload and must never
    // reach production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    // React and Tailwind both emit inline styles and there is no nonce path
    // covering every case. Style injection can reskin a page, not run code.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // The signup form may only post back to us. On a page whose whole purpose
    // is collecting an address, this is the directive that matters most.
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    // Deliberately NOT widened for the email provider: the browser never talks
    // to it. The route handler does, server-side, which is what keeps the API
    // key out of the page.
    `connect-src 'self'`,
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // Next.js reads the nonce back out of this header and stamps it onto the
  // scripts it emits, which is why it must be on the *request* too.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('content-security-policy', policy);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );

  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
