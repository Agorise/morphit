/**
 * upgrade-fetch-hardening smoke (cp160 F-opscli-1).
 *
 * The ops-cli `upgrade` command fetches the Forgejo releases-latest
 * JSON from the operator-configured host (defaults to
 * git.agorise.net) to discover the newest Morphit release before
 * downloading + SHA-verifying the archive.
 *
 * Pre-cp160, `fetchLatestRelease()` in
 * `apps/ops-cli/src/commands/upgrade.ts` did `await res.json()`
 * with no body bound and no `redirect: 'manual'`.  The cp160
 * apps/ops-cli audit (cp146 finding lens applied to the small
 * workspaces) closed this as F-opscli-1.
 *
 * Threat model: the host is operator-configured, so SSRF isn't the
 * canonical attack.  The exposure is a MITM'd or compromised release
 * API returning a multi-GB JSON that OOMs the operator's upgrade run,
 * or a 30x redirect to an unexpected host on the metadata call.
 * LOW severity (operator-run CLI, operator-controlled host) but the
 * body cap + redirect:manual are cheap defense-in-depth consistent
 * with the cp151 / cp159 body-cap pattern across the codebase.
 *
 * The downloaded archive itself is SHA-256 verified downstream
 * (parseShaFile + computeSha256), so a tampered archive is already
 * caught — this smoke covers only the metadata-JSON fetch which had
 * no such downstream guard.
 *
 * `fetchLatestRelease()` is private (not exported), so this is a
 * source-sentinel smoke (same pattern as cp156 root-shell-then-
 * redirect-smoke + cp159 price-fetch-util-smoke source-sentinels):
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

const UPGRADE_PATH = resolve(
	new URL('../src/commands/upgrade.ts', import.meta.url).pathname
);
const src = readFileSync(UPGRADE_PATH, 'utf8');

/* ---------------- local strip-comments (see cp159 Lesson #1) ---------------- */

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

// After cp160, the release fetch MUST use res.text() + JSON.parse with
// the cap in between, not bare res.json().  The downloadTo() path uses
// res.arrayBuffer() (binary archive) which is fine and separate.
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

/* ---------------- scenario 6: cp160 attribution present ---------------- */

if (src.includes('F-opscli-1')) {
	pass('cp160 F-opscli-1 attribution present in source');
} else {
	fail('cp160 F-opscli-1 attribution present in source', 'no F-opscli-1 reference found');
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
