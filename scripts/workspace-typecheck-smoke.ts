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
 * RUNTIME PERFORMANCE: tsc + smoke-scripts tsc + svelte-check across all
 * workspaces takes ~150-200 seconds (cp474 added the smoke-scripts phase,
 * roughly +60s).  The run-smokes.sh default timeout is 240s, so this passes
 * unattended — but like `vitest-must-pass-smoke`, it WILL false-fail if the
 * battery is run with MORPHIT_SMOKE_TIMEOUT lowered to 90 or 120 for chunked
 * runs.  Give this one ≥240s.  This smoke runs PRE-TARBALL not on
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
	'apps/matrix-bot',
	// cp176: apps/mcp-server was missing from this gate even though it
	// is one of the 8 TS projects and ships account-name validators
	// (getListing.ts).  Added so a tsc error there can't slip through.
	'apps/mcp-server',
	// cp242: the remaining 5 workspace packages were not gated here.
	// They compile clean and are imported transitively, but a type error
	// in a file no app imports (or in an unused export) would slip past
	// the per-app tsc.  Gate every workspace so nothing escapes.
	'packages/relay-client',
	'packages/operator-config',
	'packages/release-schema',
	'packages/net-defense',
	'packages/rpc-pool'
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

// ─── svelte-kit sync FIRST, before anything typechecks apps/web (cp478) ──
//
// `apps/web/tsconfig.json` extends `./.svelte-kit/tsconfig.json` — a GENERATED
// file that only exists after `svelte-kit sync`.  Nothing in the install path
// creates it: apps/web has no `prepare` script, `npm ci` therefore doesn't run
// sync, and CI's run-smokes job builds only apps/mcp-server.  So on a genuinely
// fresh tree — a CI checkout, a handoff tarball extract, a cold runner — the file
// is absent when this smoke starts.
//
// This sync used to live inside the svelte-check loop at the BOTTOM of the file,
// which is too late: the `smoke-typecheck` phase above it already read the config
// chain.  With `.svelte-kit/tsconfig.json` missing, tsc emits
//     error TS5083: Cannot read file '…/.svelte-kit/tsconfig.json'
// and then, with the entire `paths` map gone, 28 cascade errors — of which the two
// in `scripts/` failed the gate.  A false red on a correct tree, deterministic on
// any tree nobody had run svelte-check in first.  It never fired for us because a
// warm workspace (ours, and a reused Forgejo runner) always had the file already.
//
// This is a RE-ENTRY, not a new bug.  docs/AUDIT-2026-05.md §7714 found this exact
// trap ("the smoke runner does NOT run `svelte-kit sync` before tsc, so strict
// TypeScript caught nothing") and closed it for svelte-check.  cp474's newer
// smoke-typecheck phase re-opened it by extending `./tsconfig.json` — the same
// missing generated file, one door over.  Sync once, up front, and both phases and
// any future one inherit a config that resolves.
for (const ws of WORKSPACES_SVELTE) {
	const wsPath = join(ROOT, ws);
	if (!existsSync(join(wsPath, 'svelte.config.js'))) continue;
	try {
		execSync('npx svelte-kit sync', { cwd: wsPath, stdio: 'pipe' });
		pass(`svelte-kit sync ${ws} (generates .svelte-kit/tsconfig.json)`);
	} catch (err: any) {
		// Not a skip.  Every typecheck of this workspace below reads a config that
		// extends the file this step generates; without it they measure nothing.
		const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
		fail(
			`svelte-kit sync ${ws}`,
			`sync failed, so apps/web's tsconfig chain cannot resolve and every check ` +
				`below it is meaningless:\n${out.split('\n').slice(0, 5).join('\n')}`
		);
	}
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

// ─── smoke scripts/** typecheck (cp474) ──────────────────────────
//
// Until cp474, `scripts/**` was typechecked by NOTHING.  Every workspace's
// tsconfig covers `src/**` and `test/**` only, and the battery runs smokes via
// tsx, which strips types without checking them.  So `makeRow(): OrderbookStreamRow`
// in a smoke was decorative: the annotation was never verified against the type.
//
// That is not a cosmetic gap.  It let smoke FIXTURES silently drift away from
// the shapes they claim to model, which quietly hollows out the assertions built
// on them.  What this gate found on first run across all 514 smoke files:
//   - chat-stream-smoke's row fixture omitted `order_permlink` entirely, so the
//     cp470 fix for the ~60s "fast chat is broken" outage had NO regression
//     guard — deleting the fix again would not have failed a single smoke.
//   - treasury-source-smoke's env fixture predated cp372's `blurtBase`, so
//     `resolveBlurt`'s env branch (`env.blurtBase > 0` → `undefined > 0`) was
//     unreachable in every scenario in the file.
//   - price-model-display-smoke omitted `asset`, so cp425's BARTER price-line
//     suppression — the only behaviour that function has — was never exercised.
//   - asset-registry-smoke's "registry is frozen" scenario compared a value to
//     itself and could not fail; the web registry was in fact not frozen at all.
//
// Config: each workspace gets a `tsconfig.smoke-typecheck.json` that EXTENDS its
// own tsconfig — so its own aliases, libs and strictness apply — plus the web-side
// aliases and DOM lib that cross-workspace smoke imports need, and `Bundler`
// resolution + `allowImportingTsExtensions` to match how tsx actually loads them.
// `noUncheckedIndexedAccess` is relaxed: it governs null-safety ergonomics in test
// code (`arr[0]` on an array the test just built), not fixture drift, and the
// runner does not enforce it either.
//
// Only errors in `scripts/**` fail this phase — `src/**` is pulled in
// transitively and is already gated by the tsc loop above, at its own strictness.
const SMOKE_TYPECHECK_CONFIG = 'tsconfig.smoke-typecheck.json';

/** Every directory that ships smoke .ts files, discovered rather than listed —
 *  a hardcoded list is exactly how `scripts/**` escaped typechecking for 505
 *  smokes in the first place. */
function dirsWithSmokeScripts(): string[] {
	const out: string[] = [];
	const candidates: string[] = ['.'];
	for (const group of ['apps', 'packages']) {
		const groupPath = join(ROOT, group);
		if (!existsSync(groupPath)) continue;
		for (const name of readdirSync(groupPath)) {
			candidates.push(`${group}/${name}`);
		}
	}
	for (const rel of candidates) {
		const scriptsDir = join(ROOT, rel, 'scripts');
		if (!existsSync(scriptsDir)) continue;
		const hasTs = readdirSync(scriptsDir).some((f) => f.endsWith('.ts'));
		if (hasTs) out.push(rel);
	}
	return out;
}

for (const ws of dirsWithSmokeScripts()) {
	const wsPath = join(ROOT, ws);
	const label = ws === '.' ? 'scripts/ (root)' : ws;
	if (!existsSync(join(wsPath, SMOKE_TYPECHECK_CONFIG))) {
		// Not a skip — a workspace that ships smokes and has no gate config is the
		// hole this whole phase exists to close.
		fail(
			`smoke-typecheck ${label}`,
			`ships smoke scripts but has no ${SMOKE_TYPECHECK_CONFIG}. ` +
				'Add one (extend ./tsconfig.json, include ["scripts/**/*.ts", "src/**/*.d.ts"]) ' +
				'so its smokes cannot drift from the types they claim to model.'
		);
		continue;
	}
	let out = '';
	try {
		execSync(`npx tsc -p ${SMOKE_TYPECHECK_CONFIG}`, { cwd: wsPath, stdio: 'pipe' });
	} catch (err: unknown) {
		const e = err as { stdout?: Buffer; stderr?: Buffer };
		out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
	}
	const errorLines = out.split('\n').filter((l) => l.includes('error TS'));
	const scriptErrors = errorLines.filter((l) => l.startsWith('scripts/'));
	// A tsc error carrying no `file(line,col):` prefix is not about a source file —
	// it is tsc reporting that it could not SET UP the project at all (TS5083 can't
	// read an extended config, TS6053 file not found, TS18003 no inputs…).  The
	// `startsWith('scripts/')` filter above cannot see those, so before cp478 the
	// phase swallowed them and reported PASS while typechecking nothing.
	//
	// That is not theoretical.  With `.svelte-kit/tsconfig.json` absent, apps/web
	// emitted 29 errors: 1 config-level TS5083, 26 in `src/**`, and 2 in `scripts/**`
	// — and the only reason the gate went red at all was that ONE file
	// (smoke-tsconfig-alias-parity-smoke.ts, written for an unrelated cp448 bug)
	// happens to import through `$` aliases.  Make its two imports relative and the
	// gate would report clean with the whole alias map broken.  Accidental honesty,
	// not designed honesty.
	//
	// So: a config error fails on its own, for every workspace, regardless of what
	// the source-file filter finds.
	const configErrors = errorLines.filter((l) => !/^[^\s]+\(\d+,\d+\):/.test(l));
	if (configErrors.length > 0) {
		fail(
			`smoke-typecheck ${label}`,
			`tsc could not set up the project — every check below this is vacuous, ` +
				`not clean:\n${configErrors.slice(0, 5).join('\n')}`
		);
	} else if (scriptErrors.length === 0) {
		pass(`smoke-typecheck ${label}`);
	} else {
		fail(
			`smoke-typecheck ${label}`,
			`${scriptErrors.length} error(s) in smoke scripts:\n${scriptErrors.slice(0, 5).join('\n')}`
		);
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
		// `.svelte-kit/tsconfig.json` was generated by the hoisted sync at the top of
		// this file — deliberately not re-synced here.  It sat HERE originally, which
		// is what let the two typecheck phases above run against an unresolvable config.
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
