#!/usr/bin/env tsx
/**
 * workspace-typecheck-smoke (cp44 — LL #52 closure).
 *
 * Runs `tsc --noEmit` against every TS workspace in the monorepo
 * AND `svelte-check` against apps/web.  Catches the class of bugs
 * the cp42-J-68 finding warned about: TypeScript compile errors
 * (or Svelte template errors) that survive the runtime-only smoke
 * battery because no smoke ran the actual compiler.
 *
 * What this catches that other smokes don't:
 *   - Type-union widening misses (cp42-J-68 class: ZEC+ARRR
 *     shipped with TS errors because optInPrivacyTech didn't
 *     include 'shielded-pools'; survived 2 deep-deeps before
 *     cp42-J-68 surfaced it via manual tsc invocation).
 *   - `<svelte:head>` inside {#if} blocks (cp44-J-69 class:
 *     all 13 privacy guide pages shipped without <title>/
 *     <meta description> tags for ~3 checkpoints because the
 *     Svelte compiler's error was never visible to CI).
 *   - `Object is possibly 'undefined'` under strict noUnchecked-
 *     IndexedAccess (cp44-J-70/71 class: 8 errors in jitter
 *     functions + address-history; all silent because tsx runs
 *     fine even with these warnings, and the smoke battery
 *     never ran the actual compiler).
 *   - DOM type mismatches like applicationServerKey overload
 *     (cp44-J-72 class: surfaces only under svelte-check).
 *
 * Discipline (LL #52): defensive smokes MUST include compiler
 * runs across all workspaces, not just runtime-behaviour checks.
 *
 * RUNTIME PERFORMANCE: tsc + svelte-check across 7 workspaces
 * takes ~30-60 seconds.  This smoke runs PRE-TARBALL not on
 * every commit; for fast iteration, individual workspace
 * `tsc --noEmit` is the right granularity.
 *
 * Skipped when node_modules absent (typical for fresh-clone
 * environments before npm ci); flagged as SKIP not FAIL so the
 * smoke can live in the standalone battery without breaking
 * environments that haven't installed deps yet.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

const WORKSPACES_TSC = [
	'packages/asset-registry',
	'packages/indexer-client',
	'apps/indexer',
	'apps/relay',
	'apps/ops-cli',
	'apps/matrix-bot'
];

const WORKSPACES_SVELTE = ['apps/web'];

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}
function skip(name: string, reason: string): void {
	console.log(`  ⊝ ${name}  (skipped: ${reason})`);
	skipped++;
}

console.log('\n── workspace-typecheck smoke (cp44 LL #52) ────────────\n');

// Sanity: node_modules present?
if (!existsSync(join(ROOT, 'node_modules'))) {
	skip('environment check', 'no /node_modules — run `npm ci` first');
	console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
	console.log('  ⊝ workspace-typecheck SKIPPED (environment not provisioned)');
	process.exit(0);
}

// tsc per workspace
for (const ws of WORKSPACES_TSC) {
	const wsPath = join(ROOT, ws);
	if (!existsSync(join(wsPath, 'tsconfig.json'))) {
		skip(`tsc ${ws}`, 'no tsconfig.json');
		continue;
	}
	try {
		execSync('npx tsc --noEmit', { cwd: wsPath, stdio: 'pipe' });
		pass(`tsc --noEmit ${ws}`);
	} catch (err: any) {
		const stdout = err.stdout?.toString() || '';
		const stderr = err.stderr?.toString() || '';
		const out = stdout + stderr;
		const errLines = out.split('\n').filter((l) => l.includes('error TS'));
		fail(`tsc --noEmit ${ws}`, `${errLines.length} error(s):\n${errLines.slice(0, 5).join('\n')}`);
	}
}

// svelte-check on apps/web
for (const ws of WORKSPACES_SVELTE) {
	const wsPath = join(ROOT, ws);
	if (!existsSync(join(wsPath, 'svelte.config.js'))) {
		skip(`svelte-check ${ws}`, 'no svelte.config.js');
		continue;
	}
	try {
		// Pre-sync to generate .svelte-kit/tsconfig.json if needed
		execSync('npx svelte-kit sync', { cwd: wsPath, stdio: 'pipe' });
		const out = execSync('npx svelte-check --threshold error --output human', {
			cwd: wsPath,
			stdio: 'pipe'
		}).toString();
		// svelte-check exit 0 means no errors; but it can print warnings.
		// Look for "0 errors" in summary line.
		if (out.includes(' 0 errors')) {
			pass(`svelte-check ${ws}`);
		} else {
			fail(`svelte-check ${ws}`, out.split('\n').slice(-5).join('\n'));
		}
	} catch (err: any) {
		const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
		const errLines = out.split('\n').filter((l) => l.includes('Error:'));
		fail(`svelte-check ${ws}`, `${errLines.length} error(s):\n${errLines.slice(0, 5).join('\n')}`);
	}
}

const total = passed + failed + skipped;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)`);

if (failed > 0) {
	console.error('\nworkspace-typecheck smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} compile-clean (${skipped} skipped for env reasons)`);
