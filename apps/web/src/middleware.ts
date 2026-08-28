import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy, with a per-request nonce.
 *
 * CSP is the control that turns a cross-site-scripting bug from a full account
 * compromise into a broken page. Session cookies are already `httpOnly`, so an
 * XSS payload cannot read the token — but without CSP it could still act as
 * the user, issuing requests the browser happily authenticates.
 *
 * A nonce is used rather than an allow-list of hosts. Host allow-lists are
 * routinely bypassed: one permitted CDN serving an old, exploitable library is
 * enough. A nonce is unguessable and regenerated per request, so only scripts
 * this server actually emitted will run.
 *
 * `strict-dynamic` lets those trusted scripts load their own chunks, which is
 * what makes this workable with a bundler at all.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV === 'development';

  const policy = [
    `default-src 'self'`,
    // 'unsafe-eval' is required by the dev server's hot reload and must never
    // reach production — it would re-open the hole this policy exists to close.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    // Inline styles stay permitted. React and Tailwind both emit them, and
    // there is no nonce path that covers every case. Style injection is a far
    // narrower problem than script injection — it can reskin a page, not run
    // code — so this is a deliberate, bounded concession.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    // No plugins, ever.
    `object-src 'none'`,
    // Stops an injected <base> tag silently redirecting every relative URL.
    `base-uri 'self'`,
    // Forms may only submit back to us, so injected markup cannot exfiltrate
    // credentials to another origin.
    `form-action 'self'`,
    // Clickjacking: the real defence, which X-Frame-Options only approximates.
    `frame-ancestors 'none'`,
    // XHR and fetch to our own origin only. The API is reached through the
    // Next.js rewrite, so it is same-origin from the browser's perspective.
    `connect-src 'self'`,
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // Next.js reads the nonce back out of this header and stamps it onto the
  // scripts it emits, which is why the header must be on the *request* too.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('content-security-policy', policy);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  // Deny access to hardware and sensors this application never uses, so an
  // injected iframe or script cannot request them.
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );

  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except Next.js internals and static files. Static assets need
     * no policy of their own and are served far more often than pages, so
     * skipping them keeps the middleware off the hot path.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
