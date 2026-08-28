const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fail the production build on type errors rather than shipping them.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true }, // Linting runs once, at the repo root.

  /**
   * Proxy API calls through the web origin.
   *
   * Without this the browser sees the API (:4000) as a different origin from
   * the app (:3000), which makes the session cookie third-party. Browsers
   * increasingly block those outright, and `SameSite=Lax` would withhold it
   * regardless — so login would appear to succeed and then silently fail on
   * the next request.
   *
   * Proxying makes the browser see one origin. It also mirrors production,
   * where a reverse proxy sits in front of both.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
