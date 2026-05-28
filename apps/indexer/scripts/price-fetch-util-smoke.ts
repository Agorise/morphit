/**
 * priceFetchUtil smoke (cp159 F-indexer-1/2/3).
 *
 * Pins the hardened-fetch helper that backs coingeckoFetcher.ts
 * and klingexFetcher.ts after the cp159 audit closed three
 * findings against the price-feed pipeline:
 *
 *   F-indexer-1 (MED) — no body cap on `await res.json()` from
 *     operator-configured upstream APIs.  A misbehaving (or
 *     compromised) upstream could exhaust indexer memory.
 *   F-indexer-2 (LOW) — `redirect: 'follow'` default could
 *     silently follow 30x chains to unexpected hosts.
 *   F-indexer-3 (LOW) — no User-Agent.  Default Node UA leaks
 *     Node version + identifies as headless script.
 *
 * The shared helper (`apps/indexer/src/indexer/price/priceFetchUtil.ts`)
 * exposes:
 *
 *   - PRICE_FETCH_MAX_BODY_BYTES (env-overridable; default 64 KiB)
 *   - PRICE_FETCH_USER_AGENT ("morphit-indexer/price-fetch")
 *   - readPriceBodyCapped(res, ac, url) — streaming reader with
 *     Content-Length pre-check and abort-on-cap-exceed
 *   - priceUpstreamHeaders() — { accept, user-agent }
 *   - priceUpstreamFetchInit(signal) — { method, redirect, signal }
 *
 * This smoke verifies every load-bearing piece behaves the same
 * way coingeckoFetcher + klingexFetcher rely on.
 */

import {
	PRICE_FETCH_MAX_BODY_BYTES,
	PRICE_FETCH_USER_AGENT,
	readPriceBodyCapped,
	priceUpstreamFetchInit,
	priceUpstreamHeaders
} from '../src/indexer/price/priceFetchUtil.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Local strip-comments helper.  Same shape as cp153's
 * `scripts/lib/strip-comments.ts` (block-comments first via
 * lazy match, then line-comments).  Duplicated here rather
 * than cross-imported because the repo-root helper is reached
 * via 3-level relative path that doesn't resolve cleanly under
 * tsx + tsconfig.smoke.json from `apps/indexer/scripts/`.
 * Per-workspace smoke gets its own copy; the cp153 helper
 * remains the canonical for repo-root scripts/ smokes.
 */
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
function stripComments(source: string): string {
	return source.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '');
}

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

/* ---------------- scenario 1: priceUpstreamHeaders shape ---------------- */

const headers = priceUpstreamHeaders();
if (
	headers.accept === 'application/json' &&
	headers['user-agent'] === PRICE_FETCH_USER_AGENT &&
	headers['user-agent'] === 'morphit-indexer/price-fetch'
) {
	pass('priceUpstreamHeaders returns accept + named User-Agent');
} else {
	fail(
		'priceUpstreamHeaders returns accept + named User-Agent',
		JSON.stringify(headers)
	);
}

/* ---------------- scenario 2: priceUpstreamFetchInit shape ---------------- */

const ac = new AbortController();
const init = priceUpstreamFetchInit(ac.signal);
if (
	init.method === 'GET' &&
	init.redirect === 'manual' &&
	init.signal === ac.signal
) {
	pass('priceUpstreamFetchInit returns method=GET, redirect=manual, threaded signal');
} else {
	fail(
		'priceUpstreamFetchInit returns method=GET, redirect=manual, threaded signal',
		JSON.stringify({ method: init.method, redirect: init.redirect, signalIsAc: init.signal === ac.signal })
	);
}

/* ---------------- scenario 3: cap default + bounds ---------------- */

if (PRICE_FETCH_MAX_BODY_BYTES === 64 * 1024) {
	pass(`PRICE_FETCH_MAX_BODY_BYTES default is 64 KiB (got ${PRICE_FETCH_MAX_BODY_BYTES})`);
} else {
	fail(
		`PRICE_FETCH_MAX_BODY_BYTES default is 64 KiB`,
		`actual=${PRICE_FETCH_MAX_BODY_BYTES}`
	);
}

/* ---------------- scenario 4: Content-Length pre-check rejects oversized ---------------- */

function fakeResponse(body: string, contentLength?: string): Response {
	const headers = new Headers({
		'content-type': 'application/json'
	});
	if (contentLength !== undefined) headers.set('content-length', contentLength);
	return new Response(body, { status: 200, headers });
}

async function expectThrow<T>(p: Promise<T>, marker: string): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes(marker)) return msg;
		return `wrong error: ${msg}`;
	}
}

const oversizedCl = String(PRICE_FETCH_MAX_BODY_BYTES + 1);
const oversizedRes = fakeResponse('{"ok":true}', oversizedCl);
const oversizedAc = new AbortController();
const oversizedErr = await expectThrow(
	readPriceBodyCapped(oversizedRes, oversizedAc, 'https://test.example/oversize'),
	'Content-Length'
);
if (typeof oversizedErr === 'string' && oversizedErr.includes('Content-Length')) {
	pass('Content-Length pre-check rejects oversized body before stream-read');
} else {
	fail(
		'Content-Length pre-check rejects oversized body',
		oversizedErr === null ? 'no error raised' : oversizedErr
	);
}
if (oversizedAc.signal.aborted) {
	pass('Content-Length pre-check fires abort signal');
} else {
	fail('Content-Length pre-check fires abort signal', 'signal not aborted');
}

/* ---------------- scenario 5: streaming read aborts when body exceeds cap ---------------- */

// Build a streaming response that exceeds the cap but has no Content-Length header.
// This catches the case where upstream lies about (or omits) Content-Length.
const oversized = 'x'.repeat(PRICE_FETCH_MAX_BODY_BYTES + 100);
const streamRes = new Response(oversized, {
	status: 200,
	headers: { 'content-type': 'application/json' }
});
const streamAc = new AbortController();
const streamErr = await expectThrow(
	readPriceBodyCapped(streamRes, streamAc, 'https://test.example/stream-bomb'),
	'stream'
);
if (typeof streamErr === 'string' && streamErr.includes('stream')) {
	pass('streaming reader rejects body that exceeds cap when Content-Length absent or lies');
} else {
	fail(
		'streaming reader rejects body that exceeds cap',
		streamErr === null ? 'no error raised' : streamErr
	);
}
if (streamAc.signal.aborted) {
	pass('streaming-overflow path fires abort signal');
} else {
	fail('streaming-overflow path fires abort signal', 'signal not aborted');
}

/* ---------------- scenario 6: well-formed small body reads cleanly ---------------- */

const goodPayload = '{"blurt":{"usd":0.00237}}';
const goodRes = fakeResponse(goodPayload, String(goodPayload.length));
const goodAc = new AbortController();
let goodText: string | null = null;
try {
	goodText = await readPriceBodyCapped(goodRes, goodAc, 'https://test.example/good');
} catch (err) {
	fail('well-formed small body reads cleanly', err instanceof Error ? err.message : String(err));
}
if (goodText === goodPayload) {
	pass('well-formed small body reads cleanly (round-trips intact)');
} else if (goodText !== null) {
	fail(
		'well-formed small body reads cleanly',
		`got ${JSON.stringify(goodText)} expected ${JSON.stringify(goodPayload)}`
	);
}

/* ---------------- scenario 7: source-sentinel ---------------- */

// Pin the load-bearing source text so a future refactor that
// inadvertently removes a safety property is caught by the smoke.

const utilSrc = readFileSync(
	resolve(new URL('../src/indexer/price/priceFetchUtil.ts', import.meta.url).pathname),
	'utf8'
);
const sentinels: Array<{ name: string; mustHave: string }> = [
	{
		name: 'Content-Length pre-check before stream read',
		mustHave: "res.headers.get('content-length')"
	},
	{
		name: 'streaming abort on cap-exceed',
		mustHave: 'ac.abort()'
	},
	{
		name: 'redirect:manual in fetch init',
		mustHave: "redirect: 'manual'"
	},
	{
		name: 'named User-Agent constant',
		mustHave: "'morphit-indexer/price-fetch'"
	},
	{
		name: 'env override hook for max-body-bytes',
		mustHave: 'MORPHIT_INDEXER_PRICE_FETCH_MAX_BODY_BYTES'
	},
	{
		name: 'cp159 F-indexer-1 docblock reference',
		mustHave: 'F-indexer-1'
	}
];

let sentinelMissing = 0;
const missing: string[] = [];
for (const s of sentinels) {
	if (!utilSrc.includes(s.mustHave)) {
		sentinelMissing++;
		missing.push(`${s.name} (looking for ${JSON.stringify(s.mustHave.slice(0, 60))})`);
	}
}
if (sentinelMissing === 0) {
	pass(`priceFetchUtil source contains all ${sentinels.length} required safety markers`);
} else {
	fail(
		`priceFetchUtil source contains all ${sentinels.length} required safety markers`,
		`Missing:\n      ${missing.join('\n      ')}`
	);
}

/* ---------------- scenario 8: callsite-sentinel — both fetchers actually use the helper ---------------- */

const cgSrc = readFileSync(
	resolve(new URL('../src/indexer/price/coingeckoFetcher.ts', import.meta.url).pathname),
	'utf8'
);
const klSrc = readFileSync(
	resolve(new URL('../src/indexer/price/klingexFetcher.ts', import.meta.url).pathname),
	'utf8'
);

const callsiteSentinels: Array<{ file: string; src: string; markers: string[] }> = [
	{
		file: 'coingeckoFetcher.ts',
		src: cgSrc,
		markers: [
			"from './priceFetchUtil.ts'",
			'priceUpstreamFetchInit(ac.signal)',
			'priceUpstreamHeaders()',
			'readPriceBodyCapped(res, ac, url)'
		]
	},
	{
		file: 'klingexFetcher.ts',
		src: klSrc,
		markers: [
			"from './priceFetchUtil.ts'",
			'priceUpstreamFetchInit(ac.signal)',
			'priceUpstreamHeaders()',
			'readPriceBodyCapped(res, ac, url)'
		]
	}
];

let callsiteFailed = 0;
const callsiteMissing: string[] = [];
for (const cs of callsiteSentinels) {
	for (const m of cs.markers) {
		if (!cs.src.includes(m)) {
			callsiteFailed++;
			callsiteMissing.push(`${cs.file}: ${m}`);
		}
	}
}
if (callsiteFailed === 0) {
	pass(`both price fetchers (coingecko + klingex) actually use the hardened helper`);
} else {
	fail(
		`both price fetchers use the hardened helper`,
		`Missing call-site markers:\n      ${callsiteMissing.join('\n      ')}`
	);
}

/* ---------------- scenario 9: no bare `await res.json()` in fetchers ---------------- */

// Pre-cp159, both fetchers used `await res.json()` without a body cap.
// After cp159 they MUST use readPriceBodyCapped + JSON.parse.  Catch
// any regression that reintroduces the bare `res.json()` pattern.
//
// IMPORTANT: strip comments first.  The cp159 fix annotations
// inside coingeckoFetcher's source contain the literal text
// "Replaces `await res.json()` which had no size bound" — that's
// explanation, not code.  cp153's shared stripComments() helper
// removes comments before the regex match so the smoke only
// fires on actual code-path regressions.

const bareJsonPatternMatches: string[] = [];
for (const cs of callsiteSentinels) {
	const codeOnly = stripComments(cs.src);
	if (/await\s+res\.json\(\)/.test(codeOnly)) {
		bareJsonPatternMatches.push(cs.file);
	}
}
if (bareJsonPatternMatches.length === 0) {
	pass('no bare `await res.json()` regression in price fetchers');
} else {
	fail(
		'no bare `await res.json()` regression in price fetchers',
		`Found in: ${bareJsonPatternMatches.join(', ')}`
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
