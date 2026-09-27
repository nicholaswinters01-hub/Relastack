/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fail the production build on type errors rather than shipping them.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true }, // Linting runs once, at the repo root.
  // The people page was "Team" until 2026-09-27; old links and bookmarks keep working.
  async redirects() {
    return [{ source: '/team', destination: '/employees', permanent: true }];
  },
};

export default nextConfig;
