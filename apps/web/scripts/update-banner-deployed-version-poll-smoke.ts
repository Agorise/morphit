#!/usr/bin/env tsx
/**
 * Smoke: deployed-version update poll wiring (UpdateBanner). Anchor.
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
const importsRunning =
	/import\s*\{[^}]*\brunningVersion\b[^}]*\}\s*from\s*['"]\$stores\/release['"]/.test(banner);
const importsFetch =
	/import\s*\{[^}]*\breadDeployedVersionQuick\b[^}]*\}\s*from\s*['"]\$lib\/updates\/servedVersion['"]/.test(
		banner
	);
if (importsHelpers && importsRunning && importsFetch) {
	pass('UpdateBanner imports poll helpers + runningVersion + the quick version reader');
} else {
	const miss: string[] = [];
	if (!importsHelpers) miss.push('deployedVersion helpers');
	if (!importsRunning) miss.push('runningVersion');
	if (!importsFetch) miss.push('readDeployedVersionQuick');
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
// v1.21.18 review: the poll is built by createDeployedVersionPoll (one at a
// time: a poll asked while a slow read runs joins it — behaviour-tested in
// src/lib/updates/deployedVersion.test.ts); its options are the body here.
const pollBody = body(banner, /const pollDeployedVersion = createDeployedVersionPoll\(/);
if (!pollBody) {
	fail('pollDeployedVersion not found', 'the deployed-version fallback is missing');
} else {
	// #3 cache-busted + no-store fetch of verify.json
	// v1.20.3: the read goes through the shared reader ($lib/updates/
	// servedVersion); the cache-proofing lives there. (The release check no
	// longer reads verify.json at all, so this poll is its only reader.)
	// v1.21.18: the poll reads /version.json (a few bytes) through the quick
	// reader, which falls back to the cache-busted verify.json read only when
	// the server has no version.json — and then at most every few minutes.
	const shared = readFileSync(
		join(REPO_ROOT, 'apps/web/src/lib/updates/servedVersion.ts'),
		'utf-8'
	);
	const quick = shared.slice(shared.indexOf('export const readDeployedVersionQuick'));
	const fetchesBusted =
		/verifyJsonPollUrl\s*\(/.test(shared) && /versionJsonPollUrl\s*\(/.test(quick);
	const noStore = /cache:\s*['"]no-store['"]/.test(quick);
	const fallsBack = /fallback:\s*\(\)\s*=>\s*readServedVersion\(\{\s*maxAgeMs:\s*0\s*\}\)/.test(
		quick
	);
	const throttled = /QUICK_FALLBACK_GAP_MS/.test(shared) && /lastFallbackAt/.test(shared);
	const usesShared = /read:\s*readDeployedVersionQuick\b/.test(pollBody);
	if (fetchesBusted && noStore && usesShared && fallsBack && throttled) {
		pass(
			'pollDeployedVersion reads /version.json (cache-busted, no-store), verify.json only as a throttled fallback'
		);
	} else {
		const miss: string[] = [];
		if (!usesShared) miss.push('readDeployedVersionQuick() in pollDeployedVersion');
		if (!fetchesBusted) miss.push('versionJsonPollUrl()/verifyJsonPollUrl() in servedVersion.ts');
		if (!noStore) miss.push("cache:'no-store' on the version.json read");
		if (!fallsBack) miss.push('the verify.json fallback');
		if (!throttled) miss.push('the fallback throttle');
		fail('pollDeployedVersion fetch is not cache-proof / not cheap', `missing: ${miss.join('; ')}`);
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
	pass(
		`pollDeployedVersion is invoked from ${pollCallSites} sites (mount + foreground + reconnect)`
	);
} else {
	fail(
		`pollDeployedVersion is invoked from only ${pollCallSites} site(s)`,
		'expected it wired into mount, visibilitychange, and online'
	);
}

// ── #7 applyUpdate no longer early-returns without a waiting worker ───────
// v1.20.2 (PageSpeed) — verify.json is ~80 KB on the wire. Fetched the moment
// the banner mounts, it competed with the logo, the fonts and the page's own
// code on a phone's first load; fetched on every tab-foreground it cost 80 KB
// per app switch. The first poll now waits until the page has loaded and the
// browser is idle, and polls closer together than the minimum gap are skipped.
if (/whenPageSettled\(\s*\(\)\s*=>\s*void pollDeployedVersion\(\s*\)/.test(banner)) {
	pass('the first version poll waits until the page has loaded (whenPageSettled)');
} else {
	fail(
		'the first version poll runs at mount',
		'expected whenPageSettled(() => void pollDeployedVersion()) instead of a bare call'
	);
}
// v1.21.18: an open page learns of an upgrade within half a minute — the poll
// runs every 30 s, but only while the page is in view.
const every30 =
	/const UPDATE_POLL_INTERVAL_MS = 30_000;/.test(banner) &&
	/setInterval\(\s*\(\)\s*=>\s*\{\s*if \(document\.visibilityState === 'visible'\) void pollDeployedVersion\(\);\s*\},\s*POLL_INTERVAL_MS\s*\)/.test(
		banner
	) &&
	/const POLL_INTERVAL_MS = UPDATE_POLL_INTERVAL_MS;/.test(banner);
if (every30) pass('the version poll runs every 30 s while the page is in view');
else
	fail(
		'the version poll is not every 30 s while in view',
		'an open tab would learn of an upgrade late'
	);
const settled = body(banner, /function whenPageSettled\s*\(/);
if (
	settled !== null &&
	/readyState\s*===\s*['"]complete['"]/.test(settled) &&
	/addEventListener\(\s*['"]load['"]/.test(settled) &&
	/requestIdleCallback/.test(settled) &&
	/setTimeout/.test(settled)
) {
	pass('whenPageSettled waits for load, then idle (with a timer fallback)');
} else {
	fail(
		'whenPageSettled is missing or incomplete',
		'needs readyState/load + requestIdleCallback + setTimeout fallback'
	);
}
if (
	pollBody !== null &&
	/minGapMs:\s*MIN_POLL_GAP_MS\b/.test(pollBody) &&
	/const MIN_POLL_GAP_MS = \d[\d_]*;/.test(banner) &&
	/export function createDeployedVersionPoll\b/.test(helpers) &&
	/if \(inflight !== null\) return inflight;/.test(helpers)
) {
	pass(
		'pollDeployedVersion runs one at a time and skips a poll closer than MIN_POLL_GAP_MS to the last one'
	);
} else {
	fail(
		'no minimum gap between verify.json polls',
		'every tab-foreground would download the full manifest'
	);
}

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

// v1.21.18: the build writes /version.json, and the service worker never
// answers it from its cache.
const builder = readFileSync(join(REPO_ROOT, 'scripts/build-verify-json.mjs'), 'utf-8');
const dyn = readFileSync(join(REPO_ROOT, 'apps/web/src/lib/net/dynamicPaths.ts'), 'utf-8');
if (
	/resolve\(BUILD_DIR, 'version\.json'\)/.test(builder) &&
	/pathname === '\/version\.json'/.test(dyn)
) {
	pass('the build writes /version.json and the service worker leaves it to the network');
} else {
	fail(
		'/version.json is not written by the build or is cacheable by the service worker',
		'the quick poll would 404 or read a stale copy'
	);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} update-banner-deployed-version-poll scenarios passed`);
