/**
 * upgrade-fetch-hardening smoke.
 *
 * The ops-cli `upgrade` command fetches the Forgejo releases-latest
 * JSON from the operator-configured host (defaults to
 * git.agorise.net) to discover the newest Morphit release before
 * downloading + SHA-verifying the archive.
 *
 * Previously, `fetchLatestRelease()` in
 * `apps/ops-cli/src/commands/upgrade.ts` did `await res.json()`
 * with no body bound and no `redirect: 'manual'`.  The
 * apps/ops-cli audit (finding lens applied to the small
 * workspaces) closed this.
 *
 * Threat model: the host is operator-configured, so SSRF isn't the
 * canonical attack.  The exposure is a MITM'd or compromised release
 * API returning a multi-GB JSON that OOMs the operator's upgrade run,
 * or a 30x redirect to an unexpected host on the metadata call.
 * LOW severity (operator-run CLI, operator-controlled host) but the
 * body cap + redirect:manual are cheap defense-in-depth consistent
 * with the body-cap pattern across the codebase.
 *
 * The downloaded archive itself is SHA-256 verified downstream
 * (parseShaFile + computeSha256), so a tampered archive is already
 * caught — this smoke covers only the metadata-JSON fetch which had
 * no such downstream guard.
 *
 * `fetchLatestRelease()` is private (not exported), so this is a
 * source-sentinel smoke (same pattern as an earlier fix root-shell-then-
 * redirect-smoke + price-fetch-util-smoke source-sentinels):
 * pin the load-bearing source text so a future refactor that removes
 * the cap or the redirect:manual is caught.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

const UPGRADE_PATH = resolve(new URL('../src/commands/upgrade.ts', import.meta.url).pathname);
const src = readFileSync(UPGRADE_PATH, 'utf8');

/* ---------------- local strip-comments ( Lesson #1) ---------------- */

// Inlined rather than cross-importing scripts/lib/strip-comments.ts —
// the 3-level relative path resolves awkwardly under tsx --tsconfig
// from apps/*/scripts/.  Same 3-line shape as the canonical helper.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
function stripComments(s: string): string {
	return s.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '');
}

const codeOnly = stripComments(src);

/* ---------------- scenario 1: redirect:manual on release fetch ---------------- */

if (/redirect:\s*'manual'/.test(codeOnly)) {
	pass("fetchLatestRelease uses redirect: 'manual'");
} else {
	fail(
		"fetchLatestRelease uses redirect: 'manual'",
		'no redirect:manual found in upgrade.ts code (after comment-strip)'
	);
}

/* ---------------- scenario 2: Content-Length pre-check ---------------- */

if (
	codeOnly.includes("res.headers.get('content-length')") &&
	/RELEASE_JSON_MAX_BYTES/.test(codeOnly)
) {
	pass('fetchLatestRelease has Content-Length pre-check against RELEASE_JSON_MAX_BYTES');
} else {
	fail(
		'fetchLatestRelease has Content-Length pre-check',
		'missing content-length header check or RELEASE_JSON_MAX_BYTES constant'
	);
}

/* ---------------- scenario 3: post-text length cap ---------------- */

if (/text\.length\s*>\s*RELEASE_JSON_MAX_BYTES/.test(codeOnly)) {
	pass('fetchLatestRelease has post-text length cap (catches absent/lying Content-Length)');
} else {
	fail(
		'fetchLatestRelease has post-text length cap',
		'missing text.length > RELEASE_JSON_MAX_BYTES guard'
	);
}

/* ---------------- scenario 4: no bare await res.json() in release fetch ---------------- */

// The release fetch MUST use res.text() + JSON.parse with
// the cap in between, not bare res.json().  The downloadTo() path streams
// the binary archive to disk with an IDLE timeout (v1.16.13) — separate.
// Count bare res.json() occurrences in code (not comments).
const bareJsonCount = (codeOnly.match(/await\s+res\.json\(\)/g) || []).length;
if (bareJsonCount === 0) {
	pass('no bare `await res.json()` in upgrade.ts (release fetch uses capped text + JSON.parse)');
} else {
	fail(
		'no bare `await res.json()` in upgrade.ts',
		`found ${bareJsonCount} occurrence(s); release-metadata fetch must cap body before parse`
	);
}

/* ---------------- scenario 4b: tarball download survives a slow link (v1.16.13) ---------------- */

// The tarball download must NOT use a fixed total deadline (the old 30s cap
// guillotined healthy-but-slow downloads over a throttled, filtered
// link). It streams to disk and uses an IDLE/stall timeout that re-arms on each
// chunk, so a slow-but-progressing transfer completes; only a true stall aborts.
if (/UPGRADE_STALL_TIMEOUT_MS/.test(codeOnly) && /getReader\(\)/.test(codeOnly)) {
	pass('downloadTo streams with a stall (idle) timeout — slow links complete');
} else {
	fail(
		'downloadTo streams with a stall (idle) timeout',
		'expected UPGRADE_STALL_TIMEOUT_MS + res.body.getReader() streaming in downloadTo'
	);
}
if (
	/clearTimeout\(timer\);\s*\n\s*timer = setTimeout\(\(\) => controller\.abort\(\), UPGRADE_STALL_TIMEOUT_MS\)/.test(
		codeOnly
	)
) {
	pass('the stall timer RE-ARMS on progress (arm() resets on each chunk)');
} else {
	fail(
		'the stall timer re-arms on progress',
		'expected an arm() that clears + resets the timer on each chunk'
	);
}

/* ---------------- scenario 5: cap value is sane ---------------- */

// Pin the cap at 1 MiB — 100x+ the ~8 KB normal Forgejo release-latest
// payload.  If a future edit drops it to something absurdly small
// (would break legit upgrades) or huge (defeats the defense), flag it.
const capMatch = codeOnly.match(/RELEASE_JSON_MAX_BYTES\s*=\s*([\d*\s]+);/);
if (capMatch) {
	// Evaluate the simple arithmetic expression (e.g. "1024 * 1024").
	const expr = capMatch[1]!.trim();
	let capValue: number | null = null;
	if (/^[\d\s*]+$/.test(expr)) {
		capValue = expr
			.split('*')
			.map((s) => Number(s.trim()))
			.reduce((a, b) => a * b, 1);
	}
	if (capValue !== null && capValue >= 64 * 1024 && capValue <= 16 * 1024 * 1024) {
		pass(`RELEASE_JSON_MAX_BYTES is sane (${capValue} bytes, between 64 KiB and 16 MiB)`);
	} else {
		fail(
			'RELEASE_JSON_MAX_BYTES is sane',
			`cap value ${capValue} outside expected 64 KiB – 16 MiB range`
		);
	}
} else {
	fail('RELEASE_JSON_MAX_BYTES is sane', 'could not locate the cap constant assignment');
}

/* ---------------- config/keystore carry-forward ---------------- */
// The upgrade renames the old install to .bak then extracts a FRESH
// tarball that does NOT contain the operator's config or signing key.
// Without a carry-forward step the operator's config/keystore would be
// stranded in the backup and the instance would come up empty.  These
// pin the fix: the step must exist, must sit BETWEEN extract and npm
// ci, must copy each operator-data path, and must rollback on failure.

// 1. the preserve list names every operator-written path inside the tree
{
	const needs = [
		'morphit.config.env',
		'morphit.env',
		'apps/relay/keystore.json',
		'apps/relay/keystore.wif',
		'apps/relay/altnet',
		'morphit-hardening-checklist.md'
	];
	const missing = needs.filter((n) => !codeOnly.includes(n));
	if (missing.length === 0) {
		pass('carry-forward preserves config + keystore + altnet + checklist');
	} else {
		fail(
			'carry-forward preserves config + keystore + altnet + checklist',
			'preserve list missing: ' + missing.join(', ')
		);
	}
}

// 2. uses copyFileSync/cpSync (perm-preserving) — NOT a perm-losing write
if (codeOnly.includes('copyFileSync') && codeOnly.includes('cpSync')) {
	pass('carry-forward uses copyFileSync/cpSync (preserves 0600)');
} else {
	fail('carry-forward uses copyFileSync/cpSync (preserves 0600)', 'expected copyFileSync + cpSync');
}

// 3. carry-forward happens AFTER extract and BEFORE npm ci — in runUpgrade's
//    own order (npm ci runs in installDepsWithNpmCi, called from step 9).
{
	const runIdx = codeOnly.indexOf('export async function runUpgrade(');
	// The unpack: runOrThrow('tar', …) before v1.21.3, now under the spinner.
	const extractIdx = Math.max(
		codeOnly.indexOf("runOrThrow('tar'", runIdx),
		codeOnly.search(/runStepWithSpinner\(\s*'Unpacking the new release…',\s*'tar'/)
	);
	const carryIdx = codeOnly.indexOf('preserve', extractIdx);
	const npmCiIdx = codeOnly.indexOf('await installDepsWithNpmCi(installDir, backupDir)', runIdx);
	const ciFn = codeOnly.slice(codeOnly.indexOf('export async function installDepsWithNpmCi('));
	if (
		runIdx !== -1 &&
		extractIdx !== -1 &&
		carryIdx !== -1 &&
		npmCiIdx !== -1 &&
		/'ci', '--ignore-scripts'/.test(ciFn.slice(0, 1000)) &&
		extractIdx < carryIdx &&
		carryIdx < npmCiIdx
	) {
		pass('carry-forward sits between extract and npm ci');
	} else {
		fail(
			'carry-forward sits between extract and npm ci',
			`ordering wrong (extract=${extractIdx}, carry=${carryIdx}, npmCi=${npmCiIdx})`
		);
	}
}

// 4. failure during carry-forward rolls back (no half-migrated install)
{
	// find the carry-forward try/catch and confirm it calls rollback
	const afterCarry = codeOnly.slice(codeOnly.indexOf('preserve'));
	if (/catch[\s\S]{0,200}rollback\(installDir, backupDir, tmpDir/.test(afterCarry)) {
		pass('carry-forward failure rolls back');
	} else {
		fail('carry-forward failure rolls back', 'no rollback() in the carry-forward catch');
	}
}

/* ---------------- prerelease-aware release discovery ---------------- */
// `/releases/latest` returns only the newest NON-prerelease release
// (Forgejo API semantics).  During the beta period every release is
// a prerelease, so that endpoint 404s and upgrade saw nothing.  The
// fix: prefer /releases/latest, fall back to /releases?limit=1 (newest
// of any kind) on 404.  Pin both halves so a future edit can't drop
// the fallback and silently re-strand beta operators.

// 1. still queries /releases/latest (stable-preferred default)
// NOTE: checked against raw `src`, not `codeOnly` — the naive
// comment-stripper treats `//` in `https://…` as a line comment and
// would delete the URL.  These are URL literals, never in comments.
if (src.includes('/releases/latest')) {
	pass('upgrade still prefers /releases/latest (stable-first)');
} else {
	fail('upgrade still prefers /releases/latest (stable-first)', 'no /releases/latest query found');
}

// 2. falls back to the list endpoint when no stable exists
if (/releases\?limit=1/.test(src)) {
	pass('upgrade falls back to /releases?limit=1 for prereleases');
} else {
	fail(
		'upgrade falls back to /releases?limit=1 for prereleases',
		'no /releases?limit=1 fallback — flagged-pre-release betas would be invisible (the beta1/beta2 trap)'
	);
}

// 3. the fallback is gated on a 404 (no stable), not fired unconditionally
if (/status\s*!==\s*404/.test(codeOnly) || /status\s*===\s*404/.test(codeOnly)) {
	pass('prerelease fallback is gated on 404 (no stable release)');
} else {
	fail(
		'prerelease fallback is gated on 404',
		'fallback should trigger only when /releases/latest 404s'
	);
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
