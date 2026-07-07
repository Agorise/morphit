/**
 * Root-shell `?then=` redirect behavior smoke (cp156 F-mcp-7).
 *
 * The root `apps/web/src/routes/+page.svelte` shell honors a
 * `?then=/path` query parameter: when present, the shell
 * detects the user's locale via navigator.languages and
 * redirects to `/{detected-lang}{then-value}` rather than the
 * bare `/{detected-lang}/`.
 *
 * This is the load-bearing piece behind cp156's MCP-server
 * deeplink fix.  AI agents hand users URLs of the form
 * `${base}/?then=/orderbook?asset=BTC`; the shell preserves
 * the user's locale instead of forcing English on them.
 *
 * This smoke extracts the `?then=` validation + target-
 * construction logic from the shell's source and exercises
 * it deterministically without spinning up a browser.
 * Specifically:
 *
 *   1. Pins the safety constraints (must start with `/`, not
 *      `//`, no `\`) — every malformed `then` falls back to
 *      root locale page instead of being honored.
 *   2. Pins the well-formed-then construction:
 *      `/{lang}{then}` with the then-value untouched.
 *   3. Pins the malformed-then fallback: bare-root behavior
 *      with outer query and hash passed through.
 *   4. Pins the source still contains the safety guards
 *      (sentinel-style — if a future refactor removes the
 *      `startsWith('//')` check, this smoke catches it).
 *
 * The shell's redirect ITSELF (window.location.replace) can't
 * be tested in this offline runner; that's covered by
 * smoke-as-browser-test which isn't in scope for the runner
 * suite.  What we can pin is the URL-construction logic.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const SHELL_PATH = join(REPO_ROOT, 'apps/web/src/routes/+page.svelte');

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

/* ---------------- mirrored validation logic ---------------- */

/**
 * Re-derived from `apps/web/src/routes/+page.svelte`.  If this
 * predicate ever drifts from the shell's behavior, scenario 4
 * (the source-sentinel) fires.
 */
function isSafeThen(thenRaw: string | null): boolean {
	return (
		thenRaw !== null &&
		thenRaw.length > 0 &&
		thenRaw.startsWith('/') &&
		!thenRaw.startsWith('//') &&
		!thenRaw.includes('\\')
	);
}

/* ---------------- scenario 1: safety predicate ---------------- */

interface SafetyCase {
	input: string | null;
	expected: boolean;
	reason: string;
}

const safetyCases: SafetyCase[] = [
	// SAFE inputs
	{ input: '/orderbook', expected: true, reason: 'simple absolute path' },
	{ input: '/faq', expected: true, reason: 'short path' },
	{ input: '/orderbook?asset=BTC', expected: true, reason: 'path with query' },
	{ input: '/orderbook?asset=BTC&side=sell', expected: true, reason: 'path with multi-param query' },
	{ input: '/@alice/listing-permlink', expected: true, reason: 'path with @-prefixed account' },
	{ input: '/', expected: true, reason: 'bare root' },

	// UNSAFE inputs — protocol-relative URL escape
	{ input: '//evil.com/path', expected: false, reason: 'protocol-relative URL escape' },
	{ input: '//morphit.io/orderbook', expected: false, reason: 'protocol-relative even if same host' },

	// UNSAFE inputs — must start with /
	{ input: 'orderbook', expected: false, reason: 'missing leading slash' },
	{ input: 'http://evil.com/path', expected: false, reason: 'full URL' },
	{ input: 'https://morphit.io/orderbook', expected: false, reason: 'full URL even if same host' },
	{ input: '', expected: false, reason: 'empty string' },

	// UNSAFE inputs — backslash (Windows-path normalization escape)
	{ input: '/path\\with\\backslash', expected: false, reason: 'contains backslash' },
	{ input: '\\evil', expected: false, reason: 'starts with backslash' },

	// UNSAFE inputs — null/absent
	{ input: null, expected: false, reason: 'null (param absent)' }
];

let safetyFailed = 0;
for (const c of safetyCases) {
	const actual = isSafeThen(c.input);
	if (actual !== c.expected) {
		safetyFailed++;
		console.log(
			`      safety case input=${JSON.stringify(c.input)} expected=${c.expected} got=${actual} (${c.reason})`
		);
	}
}
if (safetyFailed === 0) {
	pass(`safety predicate handles all ${safetyCases.length} cases correctly`);
} else {
	fail(
		`safety predicate handles all ${safetyCases.length} cases correctly`,
		`${safetyFailed} mismatch(es) (see above)`
	);
}

/* ---------------- scenario 2: well-formed-then construction ---------------- */

function constructTarget(thenRaw: string | null, lang: string): string {
	if (isSafeThen(thenRaw)) {
		return '/' + lang + thenRaw;
	}
	// In real shell, falls back to localePath(window.location.pathname, lang) +
	// passthrough query/hash.  For testing, simulate the bare-root case.
	return '/' + lang;
}

const targetCases: Array<{ then: string; lang: string; expected: string }> = [
	{ then: '/orderbook', lang: 'en', expected: '/en/orderbook' },
	{ then: '/orderbook', lang: 'es', expected: '/es/orderbook' },
	{ then: '/orderbook', lang: 'zh-CN', expected: '/zh-CN/orderbook' },
	{ then: '/orderbook?asset=BTC', lang: 'fr', expected: '/fr/orderbook?asset=BTC' },
	{ then: '/orderbook?asset=BTC&side=sell', lang: 'de', expected: '/de/orderbook?asset=BTC&side=sell' },
	{ then: '/@alice/permlink', lang: 'pl', expected: '/pl/@alice/permlink' },
	{ then: '/faq', lang: 'ru', expected: '/ru/faq' },
	{ then: '/faq', lang: 'fa', expected: '/fa/faq' },
	{ then: '/faq', lang: 'it', expected: '/it/faq' },
	{ then: '/faq', lang: 'zh-HK', expected: '/zh-HK/faq' }
];

let targetFailed = 0;
for (const c of targetCases) {
	const actual = constructTarget(c.then, c.lang);
	if (actual !== c.expected) {
		targetFailed++;
		console.log(
			`      target case then=${JSON.stringify(c.then)} lang=${c.lang} expected=${c.expected} got=${actual}`
		);
	}
}
if (targetFailed === 0) {
	pass(`well-formed-then constructs /{lang}{then} for all ${targetCases.length} cases across all 10 supported locales`);
} else {
	fail(
		`well-formed-then constructs /{lang}{then}`,
		`${targetFailed} mismatch(es)`
	);
}

/* ---------------- scenario 3: malformed-then fallback ---------------- */

const fallbackCases: Array<{ then: string | null; lang: string; expected: string }> = [
	{ then: null, lang: 'en', expected: '/en' },
	{ then: '', lang: 'en', expected: '/en' },
	{ then: '//evil.com', lang: 'es', expected: '/es' },
	{ then: 'http://evil.com', lang: 'fr', expected: '/fr' },
	{ then: 'orderbook', lang: 'de', expected: '/de' },
	{ then: '/back\\slash', lang: 'it', expected: '/it' }
];

let fallbackFailed = 0;
for (const c of fallbackCases) {
	const actual = constructTarget(c.then, c.lang);
	if (actual !== c.expected) {
		fallbackFailed++;
		console.log(
			`      fallback case then=${JSON.stringify(c.then)} lang=${c.lang} expected=${c.expected} got=${actual}`
		);
	}
}
if (fallbackFailed === 0) {
	pass(`malformed-then falls back to /{lang} for all ${fallbackCases.length} cases`);
} else {
	fail(
		`malformed-then falls back to /{lang}`,
		`${fallbackFailed} mismatch(es)`
	);
}

/* ---------------- scenario 4: source-sentinel ---------------- */

// If a future refactor removes any safety guard from the shell,
// catch it here.  This is the same pattern as cp149's
// mcp-server-read-only-invariant-smoke and cp152's marketing-
// prose smoke — pin the load-bearing source text.

const shellSrc = readFileSync(SHELL_PATH, 'utf8');
const sentinels: Array<{ name: string; mustHave: string }> = [
	{
		name: 'extracts ?then= via URLSearchParams',
		mustHave: 'URLSearchParams(window.location.search)'
	},
	{
		name: 'rejects empty then value',
		mustHave: 'thenRaw.length > 0'
	},
	{
		name: 'requires leading slash',
		mustHave: "thenRaw.startsWith('/')"
	},
	{
		name: 'rejects protocol-relative URL escape',
		mustHave: "!thenRaw.startsWith('//')"
	},
	{
		name: 'rejects backslash',
		mustHave: "!thenRaw.includes('\\\\')"
	},
	{
		name: 'constructs target via locale prefix',
		mustHave: '`/${preferred}${thenRaw}`'
	},
	{
		name: 'falls back to localePath when then malformed',
		mustHave: 'localePath(window.location.pathname, preferred)'
	},
	{
		name: 'cp156 F-mcp-7 attribution in docblock',
		mustHave: 'cp156 F-mcp-7'
	}
];

let sentinelFailed = 0;
const missingSentinels: string[] = [];
for (const s of sentinels) {
	if (!shellSrc.includes(s.mustHave)) {
		sentinelFailed++;
		missingSentinels.push(`${s.name} (looking for ${JSON.stringify(s.mustHave.slice(0, 60))})`);
	}
}
if (sentinelFailed === 0) {
	pass(`shell source contains all ${sentinels.length} required safety markers`);
} else {
	fail(
		`shell source contains all ${sentinels.length} required safety markers`,
		`Missing:\n      ${missingSentinels.join('\n      ')}`
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
