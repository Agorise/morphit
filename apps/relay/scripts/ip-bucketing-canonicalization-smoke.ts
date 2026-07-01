#!/usr/bin/env tsx
/**
 * Morphit smoke — IP bucketing canonicalization at every relay
 * endpoint.
 *
 * The defense:
 *
 *   `canonicalBucketKey()` collapses IPv4 to /24 and IPv6 to /64.
 *   This prevents an attacker controlling a /48 IPv6 allocation
 *   (a residential ISP block, a small VPS provider) from bypassing
 *   per-IP rate limits by spinning through 65k distinct /64s.
 *
 * The regression risk:
 *
 *   When a new endpoint is added under apps/relay/src/api/ and the
 *   author writes:
 *
 *       const ip = clientIp(c);
 *       if (!limiter.allow(ip)) { ... }
 *
 *   instead of:
 *
 *       const ip = clientIp(c);
 *       const bucketKey = canonicalBucketKey(ip);
 *       if (!limiter.allow(bucketKey)) { ... }
 *
 *   the new endpoint's rate limiter is silently bypassable via
 *   IPv6 /64 enumeration.  The fix is one line in the new code,
 *   easy to forget.
 *
 * What this smoke checks:
 *
 *   For every `.ts` file under `apps/relay/src/api/`, if the file
 *   calls `clientIp(`, it must also call `canonicalBucketKey(`.
 *   If the first is true and the second false, fail.
 *
 *   This is intentionally a coarse heuristic — a file could call
 *   both and still misuse them — but it catches the easy case
 *   ("forgot to canonicalize at all") which is the realistic
 *   regression mode.
 *
 * Usage (from repo root):
 *   npx tsx apps/relay/scripts/ip-bucketing-canonicalization-smoke.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const API_DIR = join(HERE, '..', 'src', 'api');

const failures: string[] = [];

console.log('\n── ip-bucketing-canonicalization smoke ─────────────────\n');

let scanned = 0;
let withClientIp = 0;
for (const entry of readdirSync(API_DIR)) {
	const full = join(API_DIR, entry);
	if (!statSync(full).isFile() || !entry.endsWith('.ts')) continue;
	scanned++;
	const src = readFileSync(full, 'utf8');
	const usesClientIp = /\bclientIp\s*\(/.test(src);
	if (!usesClientIp) continue;
	withClientIp++;
	const usesBucketKey = /\bcanonicalBucketKey\s*\(/.test(src);
	if (!usesBucketKey) {
		failures.push(
			`${entry}: calls clientIp() but never canonicalBucketKey() — ` +
				`IPv6 /64 enumeration would bypass the rate limiter.  ` +
				`Wrap with: \`const bucketKey = canonicalBucketKey(ip)\` ` +
				`before passing to limiter.allow().`
		);
	}
}

console.log(`  scanned ${scanned} api file(s); ${withClientIp} use clientIp()`);

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} endpoint(s) skip canonicalization:`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${failures.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(
		`  ✓ all ${withClientIp} endpoints that use clientIp() canonicalize via canonicalBucketKey()`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✓ all 1 scenarios passed');
}
