/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fail the production build on type errors rather than shipping them.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true }, // Linting runs once, at the repo root.

  /**
   * Deliberately NO rewrite to the product API.
   *
   * The marketing site must stay up when the API is down — that is most of the
   * reason it is a separate app. The one thing it posts (a waitlist signup)
   * goes to its own route handler, which talks to the email provider.
   */

  /**
   * The Content-Security-Policy is set in middleware, not here, because it
   * carries a per-request nonce. A static header cannot, and a flat
   * `script-src 'self'` blocks the inline bootstrap Next.js emits — which
   * stops React hydrating while the markup still renders perfectly, so the
   * breakage is invisible unless you read the console.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      },
    ];
  },
};

export default nextConfig;
