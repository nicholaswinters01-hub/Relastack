#!/usr/bin/env node
// Produces ADMIN_USERS and ADMIN_SESSION_SECRET for the /admin sign-in.
//
//   node apps/marketing/scripts/admin-setup.mjs
//
// Asks for each account's email and password (typed passwords are hidden),
// then prints two lines to paste into Vercel's environment variables. Nothing
// is written to disk and nothing leaves this machine.
//
// The hash format is self-describing (scrypt$N$r$p$salt$hash), so
// src/lib/admin-auth.ts reads the parameters from the value itself.

import { randomBytes, scrypt } from 'node:crypto';
import { createInterface } from 'node:readline';

const N = 32768;
const r = 8;
const p = 1;
const MIN_PASSWORD = 12;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY,
});
let muted = false;
const write = rl._writeToOutput?.bind(rl);
if (write) rl._writeToOutput = (text) => (muted ? undefined : write(text));

// Read lines through one queue: rl.question drops lines that arrive before it
// is called, which loses input when answers are piped in.
const pending = [];
const waiting = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : pending.push(line)));
rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve(null)));

function ask(prompt, { hidden = false } = {}) {
  process.stdout.write(prompt);
  muted = hidden;
  return new Promise((resolve) => {
    const done = (line) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      resolve(line === null ? null : line.trim());
    };
    if (pending.length) done(pending.shift());
    else waiting.push(done);
  });
}

function hash(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error
        ? reject(error)
        : resolve(
            `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`,
          ),
    );
  });
}

const entries = [];

while (true) {
  const email = (await ask(`\nEmail for account ${entries.length + 1}: `))?.toLowerCase();
  if (email === null || email === undefined) break;
  if (!/^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/.test(email)) {
    console.log('  That does not look like an email address.');
    continue;
  }

  const password = await ask('Password (hidden): ', { hidden: true });
  if (password === null) break;
  if (password.length < MIN_PASSWORD) {
    console.log(`  Use at least ${MIN_PASSWORD} characters. Let's try that account again.`);
    continue;
  }
  if ((await ask('Same password again: ', { hidden: true })) !== password) {
    console.log("  Those didn't match. Let's try that account again.");
    continue;
  }

  entries.push(`${email}:${await hash(password)}`);
  console.log(`  Added ${email}.`);

  const more = await ask('Add another account? (y/N): ');
  if (!more || !more.toLowerCase().startsWith('y')) break;
}

rl.close();

if (entries.length === 0) {
  console.log('\nNo accounts added. Nothing to paste.');
  process.exit(1);
}

console.log('\nPaste these into Vercel → Settings → Environment Variables (Production).');
console.log('Keep them private; ADMIN_SESSION_SECRET especially.\n');
console.log(`ADMIN_USERS=${entries.join(',')}`);
console.log(`ADMIN_SESSION_SECRET=${randomBytes(32).toString('base64url')}\n`);
