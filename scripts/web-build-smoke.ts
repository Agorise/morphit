#!/usr/bin/env tsx
/**
 * web-build-smoke (v1.16.x delta audit — Phase 3 process gap).
 *
 * Runs `vite build` against apps/web and fails if the browser bundle doesn't
 * build. This closes the exact gap that let v1.16.2's browser-bundle break reach
 * CI: the battery ran `svelte-check` (TYPE checking) and `tsc`, but NOTHING ran
 * the actual bundler — so importing a Node-only module into the browser
 * (`operator-config`'s node:fs/path/util reaching the SvelteKit client bundle)
 * type-checked clean yet failed `vite build` with
 * `"resolve" is not exported by "__vite-browser-external"`. svelte-check can't
 * catch that class; only bundling does.
 *
 * Now it fails in the smoke battery (locally + in ci.yml on push) instead of in
 * release.yml AFTER the tag is pushed.
 *
 * RUNTIME: a cold `vite build` of apps/web takes ~30–60s. Like
 * workspace-typecheck-smoke + vitest-must-pass-smoke, this is a SLOW-SOLO smoke:
 * give it ≥240s. It WILL false-fail under a lowered MORPHIT_SMOKE_TIMEOUT (the
 * 90/120 chunked runs), so run it in the slow group.
 *
 * Skipped (not failed) when node_modules is absent, so a fresh clone before
 * `npm ci` doesn't break the battery.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

if (!existsSync(join(ROOT, 'node_modules'))) {
	console.log('✓ all 1 web-build check skipped (node_modules absent — run npm ci first)');
	process.exit(0);
}

try {
	execSync('npm run build:vite -w apps/web', {
		cwd: ROOT,
		stdio: 'pipe',
		timeout: 300_000,
		encoding: 'utf8'
	});
} catch (err: unknown) {
	const e = err as { stdout?: string; stderr?: string; message?: string };
	const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
	// Surface the last lines so a browser-bundle break (e.g. a Node-only import
	// reaching the client) is visible in the failure, not just "exit 1".
	const tail = out.split('\n').slice(-25).join('\n');
	console.log('✗ web-build-smoke FAILED — `vite build` did not succeed:\n');
	console.log(tail || e.message || 'unknown build error');
	console.log(
		'\nHint: a "not exported by __vite-browser-external" error means a Node-only\n' +
			'module reached the browser bundle — import the browser-safe entry instead.'
	);
	process.exit(1);
}

// Sanity: the build must have produced client output.
const built =
	existsSync(join(ROOT, 'apps/web/build')) ||
	existsSync(join(ROOT, 'apps/web/.svelte-kit/output/client'));
if (!built) {
	console.log('✗ web-build-smoke FAILED — vite build exited 0 but produced no client output');
	process.exit(1);
}

console.log('✓ all 1 web-build check passes — `vite build` produced a clean browser bundle');
process.exit(0);
