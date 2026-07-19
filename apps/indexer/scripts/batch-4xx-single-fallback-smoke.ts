#!/usr/bin/env tsx
/**
 * Morphit — batch-4xx single-fallback guard (v1.8.1).
 *
 * THE FIREFIGHT (v1.8.1): the live indexer froze — indexed_block stuck, lag
 * climbing — because four of the six default Blurt RPC nodes run edge firewalls
 * that return HTTP 406 to a JSON-RPC batch `[...]` POST while serving single
 * calls (a bare `{...}`) with 200. The batch get_block path threw a raw
 * `HTTP 406 (batch get_block)`, which is a 4xx and therefore NOT in the rpc
 * pool's rotate list — so one such node leading the pool killed every poll tick
 * with no rotation and no fallback.
 *
 * THE FIX (client.ts `getBlocks`): a 4xx (other than 429) on a batch means that
 * node's edge rejects the ARRAY framing specifically. Single calls are proven to
 * work on every node, so we now treat a batch 4xx exactly like a node that can't
 * batch: add it to `batchUnsupported` and throw `BatchUnsupportedError`, which
 * the outer catch turns into the paced one-at-a-time (single-block) fallback.
 * 429 stays a rate-limit signal; 5xx/52x stay transport errors that rotate.
 *
 * This guard pins that behaviour so a refactor can't quietly send us back to
 * dying on a 4xx.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLIENT = join(REPO, 'apps/indexer/src/blurt/client.ts');
const src = readFileSync(CLIENT, 'utf-8');

// Isolate the getBlocks method body so we assert on the batch path, not the file.
const gbStart = src.indexOf('async getBlocks(');
const gbEnd = src.indexOf('async getAccounts(', gbStart);
const gb = gbStart !== -1 && gbEnd !== -1 ? src.slice(gbStart, gbEnd) : '';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean): void {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
	if (ok) passed++;
	else failed++;
}

check('getBlocks method located', gb.length > 0);

// 1 — a 4xx (non-429) batch response routes into the batch-unsupported fallback.
const okIdx = gb.search(/if\s*\(\s*!res\.ok\s*\)/);
const fourxxIdx = gb.search(/res\.status\s*>=\s*400\s*&&\s*res\.status\s*<\s*500/);
check('a 4xx batch response is detected (res.status 400–499)', fourxxIdx !== -1);
check(
	'the 4xx branch marks the node batch-unsupported and throws BatchUnsupportedError',
	/res\.status\s*>=\s*400[\s\S]{0,200}batchUnsupported\.add\(url\)[\s\S]{0,120}new BatchUnsupportedError/.test(gb)
);

// 2 — the 4xx handling sits INSIDE the !res.ok block and BEFORE the raw HTTP throw.
const rawThrowIdx = gb.search(/throw new Error\(`HTTP \$\{res\.status\} \(batch get_block\)`\)/);
check('the 4xx short-circuit runs before the raw `HTTP <status>` throw', fourxxIdx !== -1 && rawThrowIdx !== -1 && fourxxIdx < rawThrowIdx);

// 3 — 429 is still handled as its own rate-limit signal (not swallowed by the 4xx branch).
check('429 is still thrown as HTTP 429 (rate-limit → rotate + cool)', /HTTP 429 \(batch get_block\)/.test(gb));
const idx429 = gb.indexOf("HTTP 429 (batch get_block)");
check('the 429 check precedes the 4xx short-circuit (so 429 keeps its own path)', idx429 !== -1 && okIdx !== -1 && idx429 < okIdx);

// 4 — 5xx/other still surface as a raw HTTP error so the pool rotates + cools.
check('non-4xx (5xx/52x) batch failures still throw a raw `HTTP <status>` (transport → rotate)', rawThrowIdx !== -1);

// 5 — the outer catch still performs the paced single-block fallback on BatchUnsupportedError.
check(
	'BatchUnsupportedError still drives the paced one-at-a-time fallback',
	/if\s*\(!\(err instanceof BatchUnsupportedError\)\)\s*throw err;/.test(gb)
);

console.log('');
if (failed === 0) {
	console.log(`✓ all ${passed} batch-4xx-single-fallback scenarios passed (a 4xx batch falls back to single calls, never freezes the poller)`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} batch-4xx-single-fallback check(s) failed`);
	process.exit(1);
}
