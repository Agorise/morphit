#!/usr/bin/env tsx
/**
 * fetch-must-have-timeout smoke — Part 122 cp71 (LL #73 / O-21).
 *
 * `await fetch(url)` without an AbortController + timeout hangs
 * indefinitely if the remote endpoint is slow or unresponsive.
 * cp70-D5 and cp70-D6 both fell into this trap (ops-cli/upgrade.ts
 * and stores/chainFee.ts). The pattern is used CORRECTLY in 7+
 * other places; these were drift.
 *
 * This smoke walks all .ts source files and flags `fetch(` calls
 * that lack a timeout.  A fetch is considered guarded when:
 *
 *   • The same line OR a nearby line (within ~10 lines) creates
 *     an `AbortController()` whose `.signal` is passed to the
 *     fetch via the `signal:` option, OR
 *   • The fetch is inside a function whose name suggests it's a
 *     server-side resource that explicitly wants long-lived
 *     fetches (allow_listed), OR
 *   • The fetch is inside a Service Worker context, where the
 *     browser manages the timeout via the request's own signal.
 *
 * cp70-D5/D6 reference fixes:
 *   - apps/ops-cli/src/commands/upgrade.ts: UPGRADE_FETCH_TIMEOUT_MS = 30_000
 *   - apps/web/src/lib/stores/chainFee.ts:  10s AbortController in try/finally
 *
 * Mutation test M-144: add `await fetch('https://example.com')`
 * (no signal) to any .ts file → smoke fires.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── fetch-must-have-timeout smoke (cp71 LL #73 / O-21) ──\n');

function walkTs(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit' || entry === 'dist' || entry === 'test' || entry === '.vite' || entry === 'historical') continue;
			walkTs(full, out);
		} else if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
			// Skip co-located test/spec files. The `test`-directory skip above
			// already excludes dir-based tests; this catches co-located ones
			// like `src/lib/avatar/fuzz.test.ts`, whose adversarial SVG
			// payloads contain literal `fetch('//evil')` strings (fixture
			// DATA, not a real runtime call). The smoke's concern is
			// PRODUCTION fetch() reliability, not test fixtures.
			if (
				entry.endsWith('.test.ts') ||
				entry.endsWith('.spec.ts') ||
				entry.endsWith('.test.svelte') ||
				entry.endsWith('.spec.svelte')
			) {
				continue;
			}
			out.push(full);
		}
	}
}

// Allow-list of intentional fetches where a timeout would harm UX.
//
// Each entry is anchored on a STABLE SUBSTRING of the fetch line, NOT
// a line number. A line-number anchor is fragile: the service worker
// is edited often and its hint went stale TWICE (cp252 shifted it
// 150→182, cp257 shifted it 182→190 — each shift silently broke this
// gate in CI until repaired). A content anchor survives line shifts
// and re-breaks ONLY when the fetch line itself is rewritten — which
// is exactly the moment the rationale below should be re-examined.
//
// Hygiene: any entry that no longer matches a real fetch() line is
// reported as a STALE allow-list entry (see the orphan check below),
// so this list can't silently accumulate dead exemptions that would
// mask a removed/renamed guarded fetch.
interface AllowEntry {
	/** Repo-relative path of the file containing the allowed fetch. */
	readonly file: string;
	/** A distinctive substring of the fetch line (the anchor). */
	readonly snippet: string;
	/** Why a blanket AbortController timeout would be wrong here. */
	readonly reason: string;
}
const ALLOW_LIST: readonly AllowEntry[] = [
	{
		file: 'apps/web/src/service-worker.ts',
		snippet: "cleanRedirect(await fetch(req, { cache: 'reload' }))",
		reason:
			'navigation fetch (network-first, cache:reload for a fresh shell) in the SW fetch handler — a blanket AbortController would prematurely fall back to the (possibly stale) cached shell on a slow-but-working network, reintroducing the dead-chunk staleness the network-first nav exists to prevent; the browser bounds the request, and a true network failure rejects → cached-shell offline fallback'
	},
	{
		file: 'apps/web/src/service-worker.ts',
		snippet: 'const fresh = await fetch(req)',
		reason:
			'asset cache-first network fallback in the SW fetch handler — a blanket AbortController would prematurely 503 a slow-but-working immutable asset; the browser manages the request timeout'
	},
	{
		// fetchWithTimeout itself wraps fetch() — the `signal` it passes
		// IS the timeout, but the AbortController is constructed >15 lines
		// up, beyond the smoke's look-back window, so it needs an entry.
		file: 'apps/web/src/lib/net/fetchWithTimeout.ts',
		snippet: 'fetch(input, { ...init, signal })',
		reason: 'fetchWithTimeout is the timeout-wrapping helper itself; its signal comes from an AbortController constructed earlier than the smoke window'
	},
	{
		// v1.7.5 (t.txt #4) — the batched get_block fetch. Its `signal` is the
		// pool's own: EndpointPool.attemptSingle does `new AbortController()` +
		// `setTimeout(() => ctl.abort(), timeoutMs)` and hands ctl.signal to
		// `fn(url, signal)` (packages/rpc-pool/src/index.ts:588-595). So this
		// fetch IS bounded — by a controller in a different FILE, which is well
		// outside a 10-line look-back.
		//
		// Allow-listed rather than given its own redundant controller: a second
		// timeout inside the callback would race the pool's, and whichever fired
		// first would decide the endpoint's health. The pool must own that
		// decision, because it is the thing that records the failure and rotates.
		file: 'apps/indexer/src/blurt/client.ts',
		snippet: 'res = await fetch(url, {',
		reason: 'batched get_block; the signal is the EndpointPool AbortController that already bounds every per-endpoint attempt (attemptSingle: new AbortController + setTimeout(abort, timeoutMs)). A local controller would race the pool and corrupt its health accounting.'
	}
];
const allowMatched: boolean[] = ALLOW_LIST.map(() => false);

const tsFiles: string[] = [];
for (const root of [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/web/src',
	'apps/ops-cli/src',
	'apps/matrix-bot/src',
	'packages'
]) {
	try {
		walkTs(join(REPO_ROOT, root), tsFiles);
	} catch {
		// missing dir; skip
	}
}

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly context: string;
}

const findings: Finding[] = [];
let totalFetches = 0;

for (const file of tsFiles) {
	const src = readFileSync(file, 'utf-8');
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Match `fetch(` but not method calls like `obj.fetch(` or
		// `prefetch(`, `crossFetch(`, etc.  Require the preceding char
		// to NOT be a word char or dot — so `await fetch(`, `=fetch(`,
		// `return fetch(` match but `up.fetch(` doesn't.
		if (!/(?:^|[^a-zA-Z0-9_$.])fetch\s*\(/.test(line)) continue;
		// Skip type-only / interface lines
		if (/^(\s*\*|\s*\/\/|\s*\/\*)/.test(line)) continue;
		// Skip identifier definitions
		if (/^\s*(function|const|let|var|type|interface)\s+\w*[Ff]etch/.test(line)) continue;
		totalFetches++;

		// Look at this line + next 16 lines for `signal:` option
		// (fetch options can span multiple lines, especially for POSTs
		// with body / headers).
		const windowLines = lines.slice(i, Math.min(lines.length, i + 16)).join('\n');
		const hasSignal = /signal\s*:/.test(windowLines);
		if (hasSignal) continue;

		// Look at this line + previous 10 lines for AbortController
		// definition (the controller might be hoisted into a helper)
		const prevWindow = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
		const hasAbortController = /new AbortController\(/.test(prevWindow) || /AbortSignal\.timeout\(/.test(prevWindow);
		if (hasAbortController && /signal[\s:]/.test(prevWindow)) continue;

		// Check allow-list (content-anchored, not line-anchored).
		const relPath = file.replace(REPO_ROOT + '/', '');
		let allowed = false;
		for (let ei = 0; ei < ALLOW_LIST.length; ei++) {
			const entry = ALLOW_LIST[ei];
			if (relPath !== entry.file) continue;
			if (line.includes(entry.snippet)) {
				allowed = true;
				allowMatched[ei] = true;
				break;
			}
		}
		if (allowed) continue;

		findings.push({
			file: relPath,
			line: i + 1,
			context: line.trim().slice(0, 200)
		});
	}
}

console.log(`▸ scanned ${tsFiles.length} .ts/.svelte files; found ${totalFetches} fetch() call(s)`);
console.log(`  ${findings.length} appear to lack an AbortController+timeout.\n`);

for (const f of findings) {
	fail(
		`${f.file}:${f.line} fetch() has an AbortController timeout`,
		`${f.context}\n      Add: \`const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), TIMEOUT_MS); try { await fetch(url, { signal: ac.signal }); } finally { clearTimeout(timer); }\``
	);
}

// Stale allow-list hygiene: every exemption must still match a real
// fetch() line. An orphaned entry means the guarded fetch was moved,
// renamed, or deleted — fail so the dead exemption gets cleaned up
// rather than silently masking a future un-timed fetch.
const orphaned = ALLOW_LIST.filter((_, i) => !allowMatched[i]);
for (const o of orphaned) {
	fail(
		`stale allow-list entry: ${o.file} «${o.snippet}»`,
		`no fetch() line matches this allow-list snippet anymore — the guarded fetch was moved/renamed/deleted; update the snippet or remove the entry`
	);
}

if (findings.length === 0 && orphaned.length === 0) {
	pass(`all ${totalFetches} fetch() sites have an AbortController+timeout (or are explicitly allow-listed); all ${ALLOW_LIST.length} allow-list entries still match`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nfetch-must-have-timeout smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} fetch-must-have-timeout scenarios passed`);
