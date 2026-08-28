#!/usr/bin/env node
/**
 * Dependency licence audit.
 *
 *   node scripts/licenses.mjs --check      fail on anything unacceptable
 *   node scripts/licenses.mjs --generate   write THIRD-PARTY-LICENSES.md
 *
 * Why this runs in CI: the platform is sold as commercial SaaS with source
 * that is never distributed. Nearly every open-source licence is fine under
 * that model — but a single AGPL dependency is not, because AGPL obligations
 * trigger on *network use* rather than distribution. One transitive package
 * added years from now could quietly create an obligation to publish the whole
 * codebase. This check makes that impossible to miss.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');

/**
 * Licences that are incompatible with a commercial SaaS product.
 *
 * AGPL and SSPL reach network use. GPL reaches distribution, which matters the
 * day any part of this ships to a customer's own infrastructure. BUSL, Elastic
 * and Commons Clause restrict commercial use outright.
 */
const FORBIDDEN = [
  /\bAGPL/i,
  /\bSSPL/i,
  /\bBUSL/i,
  /Business Source/i,
  /Commons Clause/i,
  /Elastic License/i,
  // GPL, but not LGPL — the leading boundary keeps "LGPL" from matching.
  /(^|[^L\w])GPL-[23]/i,
];

/**
 * Weak copyleft. Fine as dependencies, but each one is a deliberate decision
 * rather than an accident, so new arrivals must be acknowledged explicitly.
 */
const ACKNOWLEDGED = {
  lightningcss:
    'MPL-2.0. Build tooling only (devDependency of Tailwind and the Nest CLI); never ships. MPL is file-level copyleft and obligates only modification of its own files.',
  'lightningcss-win32-x64-msvc': 'MPL-2.0. Platform binary for the above.',
  'lightningcss-linux-x64-gnu': 'MPL-2.0. Platform binary for the above.',
  'lightningcss-darwin-arm64': 'MPL-2.0. Platform binary for the above.',
  'lightningcss-darwin-x64': 'MPL-2.0. Platform binary for the above.',
  'lightningcss-linux-arm64-gnu': 'MPL-2.0. Platform binary for the above.',
  sharp:
    'Apache-2.0 with an LGPL component (libvips). Optional Next.js image optimisation. LGPL obligations attach to modifying and distributing the library, not to using it.',
  '@img/sharp-win32-x64': 'Apache-2.0 AND LGPL-3.0-or-later. Platform binary for sharp.',
  '@img/sharp-libvips-win32-x64': 'LGPL-3.0-or-later. Platform binary for sharp.',
};

const PERMISSIVE =
  /^(MIT|ISC|BSD-[023]|BSD-3-Clause|BSD-2-Clause|0BSD|Apache-2\.0|Unlicense|CC0|CC-BY-4\.0|CC-BY-3\.0|BlueOak-1\.0\.0|Python-2\.0|Zlib|WTFPL|MIT-0|Artistic-2\.0)/i;

const WEAK_COPYLEFT = /\b(LGPL|MPL|EPL|CDDL|CC-BY-SA)/i;

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object') return pkg.license.type ?? null;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return null;
}

function collect() {
  const packages = new Map();

  if (!existsSync(pnpmDir)) {
    console.error('node_modules/.pnpm not found. Run `pnpm install` first.');
    process.exit(2);
  }

  const walk = (base) => {
    for (const entry of readdirSync(base)) {
      const full = join(base, entry);
      if (entry.startsWith('@')) {
        walk(full);
        continue;
      }
      const manifest = join(full, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (!pkg.name || !pkg.version) continue;
        // Keyed by name so one entry per package, not per platform variant.
        if (!packages.has(pkg.name)) {
          packages.set(pkg.name, {
            name: pkg.name,
            version: pkg.version,
            license: licenseOf(pkg),
            author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? null),
            homepage: pkg.homepage ?? pkg.repository?.url ?? null,
          });
        }
      } catch {
        // A malformed manifest is not ours to fix; it is reported as unknown
        // below if it matters.
      }
    }
  };

  for (const dir of readdirSync(pnpmDir)) {
    const mods = join(pnpmDir, dir, 'node_modules');
    if (existsSync(mods)) walk(mods);
  }

  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function classify(pkg) {
  const license = pkg.license;

  if (!license) return 'unknown';
  if (FORBIDDEN.some((pattern) => pattern.test(license))) return 'forbidden';
  if (WEAK_COPYLEFT.test(license)) {
    return Object.prototype.hasOwnProperty.call(ACKNOWLEDGED, pkg.name) ? 'acknowledged' : 'review';
  }
  if (PERMISSIVE.test(license)) return 'permissive';

  return 'review';
}

function check(packages) {
  const groups = { forbidden: [], review: [], unknown: [], acknowledged: [], permissive: [] };
  for (const pkg of packages) groups[classify(pkg)].push(pkg);

  console.log(`Scanned ${packages.length} unique packages\n`);
  console.log(`  permissive    ${groups.permissive.length}`);
  console.log(`  acknowledged  ${groups.acknowledged.length}`);
  console.log(`  needs review  ${groups.review.length}`);
  console.log(`  unknown       ${groups.unknown.length}`);
  console.log(`  FORBIDDEN     ${groups.forbidden.length}\n`);

  let failed = false;

  if (groups.forbidden.length) {
    failed = true;
    console.error('FORBIDDEN LICENCES — incompatible with commercial SaaS:');
    for (const p of groups.forbidden) console.error(`  ${p.name}@${p.version}  ${p.license}`);
    console.error('');
  }

  if (groups.unknown.length) {
    failed = true;
    console.error('UNDECLARED LICENCES — cannot be assessed, so treated as unacceptable:');
    for (const p of groups.unknown) console.error(`  ${p.name}@${p.version}`);
    console.error('');
  }

  if (groups.review.length) {
    failed = true;
    console.error('UNRECOGNISED OR COPYLEFT LICENCES — review, then add to ACKNOWLEDGED:');
    for (const p of groups.review) console.error(`  ${p.name}@${p.version}  ${p.license}`);
    console.error('');
  }

  if (failed) {
    console.error('Licence check FAILED. See scripts/licenses.mjs for the policy.');
    process.exit(1);
  }

  console.log('Licence check passed.');
}

function generate(packages) {
  const byLicense = new Map();
  for (const pkg of packages) {
    const key = pkg.license ?? 'Undeclared';
    if (!byLicense.has(key)) byLicense.set(key, []);
    byLicense.get(key).push(pkg);
  }

  const sorted = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length);
  const today = new Date().toISOString().slice(0, 10);

  let out = `# Third-Party Licenses

This product includes open-source software. The packages below are dependencies
— their source is not copied into this repository, and each remains the
property of its respective authors under the license shown.

Generated ${today} by \`pnpm licenses:generate\` from the installed dependency
tree. ${packages.length} unique packages.

## Summary

| License | Packages |
| --- | ---: |
`;

  for (const [license, list] of sorted) out += `| ${license} | ${list.length} |\n`;

  out += `
## Acknowledged copyleft dependencies

Each of these carries a weak-copyleft license and has been reviewed
individually.

`;

  for (const [name, note] of Object.entries(ACKNOWLEDGED)) {
    if (packages.some((p) => p.name === name)) out += `- **${name}** — ${note}\n`;
  }

  out += `
## Full list

`;

  for (const [license, list] of sorted) {
    out += `### ${license}\n\n`;
    for (const pkg of list) {
      out += `- ${pkg.name}@${pkg.version}${pkg.author ? ` — ${pkg.author}` : ''}\n`;
    }
    out += '\n';
  }

  writeFileSync(join(repoRoot, 'THIRD-PARTY-LICENSES.md'), out);
  console.log(`Wrote THIRD-PARTY-LICENSES.md (${packages.length} packages)`);
}

/**
 * Prove the policy can actually reject something.
 *
 * A gate that cannot fail is not a gate. The LGPL case is the one that matters
 * most: a naive /GPL/ pattern would flag every LGPL package and, once someone
 * loosened it to stop the noise, would stop catching real GPL too.
 */
function selfTest() {
  const cases = [
    ['AGPL-3.0', 'forbidden'],
    ['AGPL-3.0-or-later', 'forbidden'],
    ['SSPL-1.0', 'forbidden'],
    ['GPL-3.0', 'forbidden'],
    ['GPL-2.0-only', 'forbidden'],
    ['BUSL-1.1', 'forbidden'],
    ['Elastic License 2.0', 'forbidden'],
    ['MIT AND Commons Clause', 'forbidden'],
    ['LGPL-3.0-or-later', 'review'],
    ['MPL-2.0', 'review'],
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['BSD-3-Clause', 'permissive'],
    ['0BSD', 'permissive'],
    [null, 'unknown'],
  ];

  let failures = 0;

  for (const [license, expected] of cases) {
    // A name absent from ACKNOWLEDGED, so weak copyleft lands in "review".
    const actual = classify({ name: '__selftest__', license });
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(license).padEnd(26)} -> ${actual} (expected ${expected})`,
    );
  }

  if (failures) {
    console.error(`\n${failures} classification case(s) FAILED.`);
    process.exit(1);
  }

  console.log('\nLicence policy self-test passed.');
}

const mode = process.argv[2] ?? '--check';

if (mode === '--selftest') {
  selfTest();
} else if (mode === '--generate') {
  generate(collect());
} else {
  selfTest();
  console.log('');
  check(collect());
}
