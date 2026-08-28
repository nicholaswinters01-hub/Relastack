// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'packages/db/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/config files run in Node before any bundler is involved, so they
    // legitimately use Node globals. TypeScript files get these from
    // @types/node instead, which is why this is scoped to plain JS configs.
    files: ['**/*.mjs', '**/*.cjs', '**/*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        module: 'writable',
      },
    },
  },
  {
    rules: {
      // Unused args prefixed with _ are intentional (e.g. NestJS lifecycle signatures).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // `any` is a smell, not an error — it must be a deliberate, reviewed choice.
      '@typescript-eslint/no-explicit-any': 'warn',
      // NestJS modules are legitimately empty classes.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  prettier,
);
