#!/usr/bin/env tsx
/**
 * Smoke: deployed-version update poll wiring (UpdateBanner). Anchor cp294.
 *
 * Background. The "update available" snackbar (UpdateBanner.svelte) was not
 * appearing after deploys on mobile OR PC. Root cause: it relied solely on
 * the service-worker byte-diff (the browser refetching /service-worker.js
 * and seeing a new worker). svelte.config.js correctly sets
 * `updateViaCache: 'none'` so the BROWSER never serves the SW script stale —
 * but an upstream reverse proxy (BunkerWeb) can still serve /service-worker.js
 * stale from ITS edge cache, so the browser sees old bytes, no new worker
 * appears, and the snackbar never shows.
 *
 * Fix (the part this smoke guards): a deployed-version poll that does NOT
 * depend on the SW byte-diff. It fetches /verify.json cache-busted, parses
 * `morphit_version`, and if it differs from the running bundle's baked-in
 * version, surfaces the snackbar anyway — so the prompt appears regardless
 * of proxy caching. (The pure decision logic — parseDeployedVersion /
 * deployedVersionDiffers / verifyJsonPollUrl — is unit-tested in
 * deployedVersion.test.ts; this smoke pins the WIRING in the Svelte
 * component, which the unit test can't reach.)
 *
 * Asserts against the on-disk source:
 *   1. UpdateBanner imports the poll helpers + runningVersion + fetchWithTimeout.
 *   2. The snackbar render condition is gated on `newerVersionDeployed` (so a
 *      poll hit can show it with NO waiting service worker).
 *   3. pollDeployedVersion fetches verifyJsonPollUrl() with cache:'no-store'.
 *   4. pollDeployedVersion sets newerVersionDeployed ONLY under a
 *      deployedVersionDiffers(...) guard (never an unconditional nag).
 *   5. The 60 s setInterval calls `check` and NOT pollDeployedVersion
 *      (verify.json carries the full hash manifest — too big for a 60 s loop).
 *   6. pollDeployedVersion is actually invoked from ≥3 sites (mount +
 *      foreground + reconnect), not just defined.
 *   7. applyUpdate no longer early-returns when there is no waiting worker —
 *      the poll-detected case (proxy served the SW stale) must still reload.
 *
 * Tamper tests (each must turn the smoke red):
 *   - Drop `newerVersionDeployed` from the render condition → fails #2.
 *   - Make pollDeployedVersion set the flag unconditionally → fails #4.
 *   - Add pollDeployedVersion to the setInterval → fails #5.
 *   - Restore `if (!target) return;` at the top of applyUpdate → fails #7.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const BANNER = join(REPO_ROOT, 'apps/web/src/lib/components/UpdateBanner.svelte');
const HELPERS = join(REPO_ROOT, 'apps/web/src/lib/updates/deployedVersion.ts');

for (const p of [BANNER, HELPERS]) {
	if (!existsSync(p)) {
		console.error(`  ✗ source file missing: ${p}`);
		process.exit(1);
	}
}

const banner = readFileSync(BANNER, 'utf-8');
const helpers = readFileSync(HELPERS, 'utf-8');

let passes = 0;
let failures = 0;
function pass(m: string): void {
	console.log(`  ✓ ${m}`);
	passes++;
}
function fail(m: string, detail: string): void {
	console.error(`  ✗ ${m}`);
	console.error(`      ${detail}`);
	failures++;
}

/** Brace-match a function body from the first `{` after the signature. */
function body(src: string, sig: RegExp): string | null {
	const m = sig.exec(src);
	if (!m) return null;
	const open = src.indexOf('{', m.index + m[0].length - 1);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
	}
	return null;
}

// ── helper module sanity ─────────────────────────────────────────────────
if (
	/export function parseDeployedVersion\b/.test(helpers) &&
	/export function deployedVersionDiffers\b/.test(helpers) &&
	/export function verifyJsonPollUrl\b/.test(helpers)
) {
	pass('deployedVersion.ts exports parse/diff/url helpers');
} else {
	fail('deployedVersion.ts missing an exported helper', 'expected parse + differs + url');
}

// ── #1 imports ───────────────────────────────────────────────────────────
const importsHelpers =
	/import\s*\{[^}]*\bdeployedVersionDiffers\b[^}]*\}\s*from\s*['"]\$lib\/updates\/deployedVersion['"]/.test(
		banner
	);
const importsRunning = /import\s*\{[^}]*\brunningVersion\b[^}]*\}\s*from\s*['"]\$stores\/release['"]/.test(
	banner
);
const importsFetch = /\bfetchWithTimeout\b/.test(banner);
if (importsHelpers && importsRunning && importsFetch) {
	pass('UpdateBanner imports poll helpers + runningVersion + fetchWithTimeout');
} else {
	const miss: string[] = [];
	if (!importsHelpers) miss.push('deployedVersion helpers');
	if (!importsRunning) miss.push('runningVersion');
	if (!importsFetch) miss.push('fetchWithTimeout');
	fail('UpdateBanner missing an import', `missing: ${miss.join('; ')}`);
}

// ── #2 render condition gated on newerVersionDeployed ─────────────────────
if (/\{#if[^}]*\bnewerVersionDeployed\b[^}]*\}/.test(banner)) {
	pass('snackbar render condition includes newerVersionDeployed');
} else {
	fail(
		'render condition does not include newerVersionDeployed',
		'a poll hit with no waiting SW could never surface the snackbar'
	);
}

// ── poll body checks (#3, #4) ─────────────────────────────────────────────
const pollBody = body(banner, /async function pollDeployedVersion\s*\(/);
if (!pollBody) {
	fail('pollDeployedVersion not found', 'the deployed-version fallback is missing');
} else {
	// #3 cache-busted + no-store fetch of verify.json
	const fetchesBusted = /verifyJsonPollUrl\s*\(/.test(pollBody);
	const noStore = /cache:\s*['"]no-store['"]/.test(pollBody);
	if (fetchesBusted && noStore) {
		pass("pollDeployedVersion fetches verifyJsonPollUrl() with cache:'no-store'");
	} else {
		const miss: string[] = [];
		if (!fetchesBusted) miss.push('verifyJsonPollUrl()');
		if (!noStore) miss.push("cache:'no-store'");
		fail('pollDeployedVersion fetch is not cache-proof', `missing: ${miss.join('; ')}`);
	}

	// #4 sets the flag ONLY under a deployedVersionDiffers guard.
	const setIdx = pollBody.indexOf('newerVersionDeployed = true');
	const guardIdx = pollBody.indexOf('deployedVersionDiffers');
	if (setIdx >= 0 && guardIdx >= 0 && guardIdx < setIdx) {
		pass('pollDeployedVersion sets the flag only under a deployedVersionDiffers guard');
	} else {
		fail(
			'newerVersionDeployed is set without a version-diff guard',
			'the snackbar must only appear when the deployed version actually differs'
		);
	}
}

// ── #5 the 60s interval calls check, NOT the heavy poll ───────────────────
const intervalCall = /setInterval\(\s*([A-Za-z0-9_]+)\s*,\s*60_000\s*\)/.exec(banner);
if (!intervalCall) {
	fail('60s setInterval not found', 'expected setInterval(check, 60_000)');
} else if (intervalCall[1] === 'check') {
	// And make sure pollDeployedVersion isn't *also* the interval target via a
	// wrapper: the interval arg must be the lightweight check, not the poll.
	pass('periodic 60s timer runs the lightweight check (not the heavy verify.json poll)');
} else {
	fail(
		`60s timer runs ${intervalCall[1]}, expected check`,
		'verify.json carries the full hash manifest — polling it every 60s is wasteful'
	);
}

// ── #6 poll is actually invoked (mount + foreground + reconnect) ──────────
// Count call sites = total occurrences minus the definition (`function pollDeployedVersion`).
const pollMentions = (banner.match(/pollDeployedVersion/g) ?? []).length;
const pollCallSites = pollMentions - 1; // minus the definition
if (pollCallSites >= 3) {
	pass(`pollDeployedVersion is invoked from ${pollCallSites} sites (mount + foreground + reconnect)`);
} else {
	fail(
		`pollDeployedVersion is invoked from only ${pollCallSites} site(s)`,
		'expected it wired into mount, visibilitychange, and online'
	);
}

// ── #7 applyUpdate no longer early-returns without a waiting worker ───────
const applyBody = body(banner, /function applyUpdate\s*\(/);
if (!applyBody) {
	fail('applyUpdate not found', 'cannot verify the no-waiting-worker path');
} else if (/if\s*\(\s*!\s*target\s*\)\s*return/.test(applyBody)) {
	fail(
		'applyUpdate still early-returns when there is no waiting worker',
		'a poll-detected update (proxy served the SW stale) must still trigger a reload'
	);
} else {
	pass('applyUpdate handles the no-waiting-worker case (no early `if (!target) return`)');
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} update-banner-deployed-version-poll scenarios passed`);
