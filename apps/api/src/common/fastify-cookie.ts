import cookie from '@fastify/cookie';

/**
 * The @fastify/cookie plugin, typed so Fastify's `register()` accepts it.
 *
 * The package uses `export =`, and its default export is declared as a
 * non-callable interface even though the runtime value is the plugin function.
 * A default import therefore type-checks as something un-registerable.
 *
 * `import cookie = require(...)` fixes the type but is illegal under ESM, and
 * the test suite is transpiled as ESM by SWC — so that form breaks the tests
 * while fixing the build. Importing `FastifyPluginCallback` to cast precisely
 * would mean declaring `fastify` as a direct dependency, which in Phase 0
 * produced two copies of Fastify with mutually incompatible types.
 *
 * A single narrow cast, in one place, is the cheapest correct answer. The
 * runtime contract is verified by the e2e suite: cookies are set, read back,
 * and cleared.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fastifyCookiePlugin = cookie as any;
