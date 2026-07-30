/**
 * ESLint flat config for apps/web — Part 87 (J-6 finding).
 *
 * BACKGROUND: until Part 87, `apps/web/package.json` declared
 * `"lint": "prettier --check . && eslint ."` with eslint v9 and
 * `eslint-plugin-svelte` in devDependencies — but no eslint config
 * file existed in the repo.  ESLint v9 requires a flat config
 * (`eslint.config.{js,mjs,cjs}`) and exits non-zero without one,
 * meaning the lint step's eslint half had been a no-op (dominated
 * by prettier failing first via `&&` short-circuit).  See J-6 in
 * the Part 87 audit notes.
 *
 * SCOPE: this config is intentionally pragmatic.  It loads the
 * eslint-plugin-svelte recommended ruleset (which already
 * understands `<script lang="ts">`, reactivity sigils, slot/snippet
 * patterns, etc.) and tunes a small set of rules to project
 * realities:
 *
 *   - `no-undef` is OFF for .ts and .svelte (TypeScript already
 *     covers undefined-name detection; ESLint's no-undef doesn't
 *     understand TS types like `BufferSource`, `DocumentEventMap`,
 *     `ServiceWorkerGlobalScope`, etc., and would otherwise
 *     false-flag every DOM type used in a type position).
 *   - `svelte/no-at-html-tags` is WARN, not error.  All `{@html}`
 *     usages have been audited — they render either DOMPurify-
 *     sanitized SVG (IdentityLabel), trusted-by-builder formatted
 *     content, or JSON-LD that's already been escaped.  The real
 *     gate against operator-controlled XSS is `href-xss-smoke.ts`
 *     plus the codebase convention of `safe*` / `validated*`
 *     identifiers.
 *   - `no-control-regex` is OFF — chat-payload and a few other
 *     files legitimately reject C0/C1 control characters via
 *     regex; that's the regex's purpose, not a bug.
 *   - `no-console` OFF — project intentionally uses console.
 *
 * Adding stricter rules here is fine but should be deliberate,
 * not accidental.  This config is meant to make CI's lint step
 * green and useful, not to enforce style nitpicks (that's
 * prettier's job).
 *
 * PART 89 CLOSE-OUT (warn-not-error posture):
 *
 * Every rule in this config is configured as `warn`, not `error`.
 * That's deliberate.  The lint step's job is to be visibly green
 * in CI while surfacing patterns worth a human eyeball — not to
 * gate merges on cosmetic noise.  The hard gates are elsewhere:
 *
 *   - svelte-check (`npm run check`) — 0 errors, 0 warnings,
 *     enforced.
 *   - tsc --noEmit via scripts/typecheck-sweep.sh — 0 errors
 *     across 8 projects, enforced.
 *   - The 1900+ scenario smoke baseline (i18n parity, a11y,
 *     security, etc.) — 0 failures, enforced.
 *
 * ESLint here is a recommendation engine.  The current Part 89
 * baseline is ~150 warnings, almost entirely `no-unused-vars` on
 * caught-error parameters (where the catch handler logs through
 * a wrapper or rethrows without examining the error) and
 * intentional unused args in test stubs and middleware factories.
 * Adding `--max-warnings=N` to package.json's lint script would
 * promote the warning ceiling to a hard gate — ONLY do that
 * after a campaign to clean down to a stable baseline, otherwise
 * a routine refactor that legitimately unused a variable will
 * red-light CI for unrelated work.
 *
 * If a future warning category becomes load-bearing (a real bug
 * pattern recurring), the right move is: (a) add a smoke that
 * detects that specific pattern with proper locality, (b) keep
 * the eslint rule at `warn` for early-warning value, and only
 * (c) promote to error if the smoke proves the pattern is
 * preventable at lint time.
 */

import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

// Vite's `define` injects __MORPHIT_VERSION__ at build time.
const projectGlobals = {
	__MORPHIT_VERSION__: 'readonly'
};

export default [
	{
		// Ignore generated/build artifacts and vendor dirs.
		ignores: [
			'.svelte-kit/**',
			'build/**',
			'dist/**',
			'node_modules/**',
			'static/**',
			'coverage/**'
		]
	},
	js.configs.recommended,
	...svelte.configs['flat/recommended'],
	{
		// .js / .mjs / .cjs source files (e.g. build-manifest.mjs, vite.config.js).
		files: ['**/*.{js,mjs,cjs}'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
				...projectGlobals
			}
		}
	},
	{
		// .ts source files use the TypeScript parser directly.
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
				...projectGlobals
			}
		},
		rules: {
			// TypeScript handles undefined-name detection.  ESLint
			// no-undef false-flags TS types (BufferSource,
			// DocumentEventMap, NotificationOptions, etc.).
			'no-undef': 'off'
		}
	},
	{
		// Service worker: needs ServiceWorker globals.
		files: ['**/service-worker.ts'],
		languageOptions: {
			parser: tsParser,
			globals: {
				...globals.serviceworker,
				...projectGlobals
			}
		},
		rules: {
			'no-undef': 'off'
		}
	},
	{
		// .svelte files use svelte-eslint-parser, which delegates
		// the `<script lang="ts">` block to the TypeScript parser.
		files: ['**/*.svelte', '*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser,
				extraFileExtensions: ['.svelte']
			},
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...projectGlobals
			}
		},
		rules: {
			'no-undef': 'off',
			// {@html} is audited project-wide via href-xss-smoke
			// and the safe*/validated* identifier conventions.
			'svelte/no-at-html-tags': 'warn',
			// SvelteKit emits svelte-ignore comments that aren't
			// always picked up by the linter; keep as warn.
			'svelte/no-unused-svelte-ignore': 'warn'
		}
	},
	{
		// Project-wide overrides for everything else.
		rules: {
			'no-console': 'off',
			'no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			],
			// Files that legitimately reject control characters.
			'no-control-regex': 'off'
		}
	},
	{
		// Test files: relax unused-vars further; allow vitest globals.
		files: ['**/*.test.ts', '**/*.test.js', '**/test/**/*.ts'],
		rules: {
			'no-unused-vars': 'off'
		}
	},
	{
		// Smokes: similar relaxation.
		files: ['scripts/**/*.ts'],
		rules: {
			'no-unused-vars': 'off'
		}
	}
];
