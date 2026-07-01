#!/usr/bin/env tsx
/**
 * Smoke: update-surface no-cache config parity. Anchor cp294.
 *
 * THE BUG THIS GUARDS AGAINST. The update snackbar stopped appearing after
 * deploys because `/service-worker.js` was served stale by the upstream
 * proxy. `ops/nginx/web.conf` (bare-metal) HAD a `location = /service-worker.js`
 * block with `Cache-Control: no-cache`, but `ops/bunkerweb/frontend/nginx.conf`
 * (the config the BunkerWeb deployment actually runs) was MISSING it — the two
 * shipped nginx configs had drifted, on the exact file whose header says "keep
 * the two in sync." This smoke makes that drift impossible to reintroduce: BOTH
 * shipped frontend nginx configs MUST mark `/service-worker.js` AND `/verify.json`
 * no-cache, and the operator doc's inline example must too.
 *
 * Accepts either no-cache idiom, since the configs legitimately use both:
 *   - `add_header Cache-Control "no-cache"` (web.conf / bunkerweb — re-emit form), or
 *   - `expires -1;` (RUN-A inline example — preserves inherited security headers).
 *
 * Tamper tests (each must turn this smoke red):
 *   - Delete the /service-worker.js block from the BunkerWeb config → fails.
 *   - Delete the /verify.json block from web.conf → fails.
 *   - Change a block's no-cache to a long max-age → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Files that serve the frontend and so must mark the update surface no-cache. */
const TARGETS = [
	{ path: 'ops/nginx/web.conf', label: 'bare-metal web.conf' },
	{ path: 'ops/bunkerweb/frontend/nginx.conf', label: 'BunkerWeb frontend nginx.conf' },
	{ path: 'docs/RUN-A-MORPHIT-NODE.md', label: 'RUN-A inline nginx example' }
];

/** The two paths whose responses must never be cached. */
const SURFACE = ['/service-worker.js', '/verify.json'];

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

/**
 * Pull the body of an `location = <path> { … }` block (brace-matched) from a
 * config/doc. Returns null if the exact-match location isn't present. Works for
 * both the multi-line form and the `location = /x { expires -1; … }` one-liner.
 */
function exactLocationBody(src: string, locPath: string): string | null {
	// Match `location = /service-worker.js {`  (allow flexible whitespace).
	const re = new RegExp(`location\\s*=\\s*${locPath.replace(/[.\\/]/g, '\\$&')}\\s*\\{`);
	const m = re.exec(src);
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

/** Does a location body assert no-cache (either idiom) and NOT a long max-age? */
function assertsNoCache(body: string): { ok: boolean; reason: string } {
	const hasNoCacheHeader = /Cache-Control\s+["']?[^"';]*no-cache/i.test(body);
	const hasExpiresMinus1 = /expires\s+-1\s*;/i.test(body);
	const hasNoStore = /Cache-Control\s+["']?[^"';]*no-store/i.test(body);
	// Guard against a regression that swaps no-cache for a cacheable directive.
	const longMaxAge = /max-age\s*=\s*([0-9]+)/i.exec(body);
	if (longMaxAge && Number(longMaxAge[1]) > 0 && !hasNoCacheHeader && !hasExpiresMinus1) {
		return { ok: false, reason: `block sets max-age=${longMaxAge[1]} without no-cache` };
	}
	if (hasNoCacheHeader || hasExpiresMinus1 || hasNoStore) return { ok: true, reason: '' };
	return { ok: false, reason: 'no `Cache-Control: no-cache`, `no-store`, or `expires -1`' };
}

for (const { path, label } of TARGETS) {
	const full = join(REPO_ROOT, path);
	if (!existsSync(full)) {
		fail(`${label}: file missing`, full);
		continue;
	}
	const src = readFileSync(full, 'utf-8');
	for (const surface of SURFACE) {
		const body = exactLocationBody(src, surface);
		if (body === null) {
			fail(
				`${label}: missing \`location = ${surface}\` block`,
				'the update snackbar breaks if this surface is served cacheable — this is the drift that caused the original bug'
			);
			continue;
		}
		const verdict = assertsNoCache(body);
		if (verdict.ok) {
			pass(`${label}: ${surface} is no-cache`);
		} else {
			fail(`${label}: ${surface} block is not no-cache`, verdict.reason);
		}
	}
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} update-surface-nocache-config scenarios passed`);
