#!/usr/bin/env tsx
/*
 * order-expiry-day-floor — cp175 F-015 guard.
 *
 * Order `expires_at` is broadcast on the public Blurt chain. If it is computed
 * as `new Date(Date.now() + expiresDays * 86_400_000)`, its ISO string carries
 * the submit moment to millisecond precision (…T14:23:47.831Z). Because the
 * interval is a round number of days, an observer can subtract it to recover
 * the client's exact wall-clock at submit time — a secondary timing/clock-skew
 * fingerprint independent of (and finer than) the block time.
 *
 * F-015 introduced `makeExpiryFlooredUtcDay()` (in $lib/orders/payload) which
 * floors to UTC midnight, and routed the /post and /post/edit call sites
 * through it. This sentinel:
 *   1. asserts the helper actually floors to 00:00:00.000Z and never exceeds
 *      the requested interval (floor, not round-up — stays under the indexer's
 *      MAX_EXPIRES_AT_DAYS ceiling);
 *   2. asserts NO order-form call site reintroduces the raw
 *      `Date.now() + ...expiresDays...* 86_400_000` pattern.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeExpiryFlooredUtcDay } from '../src/lib/orders/payload';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', 'src');

let pass = 0;
let fail = 0;
function ok(name: string): void {
	console.log(`  ✓ ${name}`);
	pass++;
}
function bad(name: string, detail: string): void {
	console.log(`  ✗ ${name}: ${detail}`);
	fail++;
}

console.log('\n── order-expiry-day-floor (cp175 F-015 guard) ──\n');

// 1. Helper floors to UTC midnight.
for (const days of [1, 14, 90, 365]) {
	const d = makeExpiryFlooredUtcDay(days);
	const iso = d.toISOString();
	if (!iso.endsWith('T00:00:00.000Z')) {
		bad(`floor(${days}d)`, `expected UTC midnight, got ${iso}`);
		continue;
	}
	// Must not exceed the requested interval (floor, not ceil): the floored
	// value is <= now + days*86400000.
	const upper = Date.now() + days * 86_400_000;
	if (d.getTime() > upper) {
		bad(`floor(${days}d)`, `floored time ${iso} exceeds now+${days}d — must floor, not round up`);
		continue;
	}
	// And it should be within one day below the upper bound (sanity: it's the
	// start of the target day, not wildly off).
	if (upper - d.getTime() >= 2 * 86_400_000) {
		bad(`floor(${days}d)`, `floored time ${iso} is more than a day below now+${days}d`);
		continue;
	}
	ok(`floor(${days}d) → ${iso} (UTC midnight, ≤ requested)`);
}

// 2. No order-form call site uses the raw millisecond-precision pattern.
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry.startsWith('.')) continue;
			out.push(...walk(p));
		} else if (entry.endsWith('.svelte') || entry.endsWith('.ts')) {
			out.push(p);
		}
	}
	return out;
}

// Match `Date.now() + <something with expiresDays> * 86_400_000` (or 86400000),
// i.e. an unfloored day-interval expiry. The helper's own definition uses this
// internally, so we exclude the payload module that defines it.
const RAW_RE = /Date\.now\(\)\s*\+\s*expiresDays\s*\*\s*86[_]?400[_]?000/;
const offenders: string[] = [];
for (const f of walk(WEB_SRC)) {
	const rel = relative(WEB_SRC, f);
	// payload.ts legitimately contains the expression inside makeExpiryFlooredUtcDay.
	if (rel.endsWith('lib/orders/payload.ts')) continue;
	const src = readFileSync(f, 'utf8');
	if (RAW_RE.test(src)) offenders.push(rel);
}
if (offenders.length === 0) {
	ok('no order-form call site uses the raw unfloored Date.now()+expiresDays*86_400_000 pattern');
} else {
	for (const o of offenders) {
		bad(o, 'uses raw unfloored expiry — route it through makeExpiryFlooredUtcDay (cp175 F-015)');
	}
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
