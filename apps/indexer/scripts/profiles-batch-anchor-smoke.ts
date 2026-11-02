#!/usr/bin/env tsx
/*
 * profiles-batch-anchor — what the /v1/profiles batch starts from.
 *
 * The batch must return an account when EITHER table knows it: `profiles`
 * (display name, avatar) or `accounts` (the posting key). It has been wrong
 * both ways:
 *
 *   - v1.5.5 (t155): anchored on `profiles`, it returned nothing for an account
 *     that never set a display name, so its truncated key was missing under
 *     @tester2 on the review cards. The fix moved the anchor to `accounts`.
 *   - v1.21.21: anchored on `accounts`, it returned nothing for an account with
 *     a profile and no `accounts` row. That table is written only for account
 *     creations this indexer saw and for a first-buy waiver or first-trade
 *     bonus claim, so an older account this indexer never recorded (@classx)
 *     had the identicon in the header, the orderbook and chat while its own
 *     profile page (the single route) showed its avatar.
 *
 * Now the query starts from the REQUESTED names and joins both tables. The
 * behaviour is proven on Postgres through the real route in
 * test/integration/profiles-batch.test.ts; this smoke keeps the two traps that
 * ride with a batch that can return profile-less rows:
 *
 *   1. rowToProfile must not crash on a profile-less row (NULL updated_at /
 *      source_block_num), on an endpoint shared by FeaturedOrders, the profile
 *      page and the orderbook.
 *   2. NEGATIVE CACHING. A partial batch is served `no-store`; completeness
 *      must count rows that HAVE a profile (has_profile), not row presence, or
 *      a profile-less batch is pinned for 90s and hides a fresh profile.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src/api/profiles.ts');
const src = readFileSync(SRC, 'utf8');
const flat = src.replace(/\s+/g, ' ');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, why = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${why ? `: ${why}` : ''}`);
	}
}

// ── 1. the anchor ───────────────────────────────────────────────────
check(
	'the batch starts from the requested names',
	/FROM unnest\(\$1::text\[\]\) AS q\(name\)/.test(flat),
	'starting from either table drops the accounts only the other one knows'
);
check(
	'it joins accounts and profiles on the requested name',
	/LEFT JOIN accounts a ON a\.name = q\.name LEFT JOIN profiles p ON p\.account = q\.name/.test(
		flat
	),
	'both joins must hang off the requested name, not off each other'
);
check(
	'it keeps a row that either table has',
	/WHERE a\.name IS NOT NULL OR p\.account IS NOT NULL/.test(flat),
	'requiring one table re-imposes that table as the anchor'
);
check(
	'the single-account route stays profiles-anchored (deliberately)',
	/FROM profiles p LEFT JOIN accounts a ON a\.name = p\.account WHERE p\.account = \$1/.test(flat),
	'/v1/profiles/:account promises "the profile, or 404" — a caller asking for ONE profile wants a profile, and a 200 with every field null would break that contract. Only the BATCH ("tell me what you can render for these accounts") should resolve a key-only account.'
);

// ── 2. TRAP ONE: null-safety ────────────────────────────────────────
check(
	'source_block_num is null-guarded before parseInt',
	/source_block_num: r\.source_block_num === null \? null : parseInt\(/.test(flat),
	'a profile-less row has NULL here — bare parseInt() yields NaN on a shared endpoint'
);
check(
	'updated_at is null-guarded before toISOString',
	/updated_at: r\.updated_at === null \? null : r\.updated_at\.toISOString\(\)/.test(flat),
	'a profile-less row has NULL here — bare .toISOString() THROWS, taking out FeaturedOrders, the profile page and the orderbook'
);

// ── 3. TRAP TWO: negative caching ───────────────────────────────────
check(
	'batch completeness keys off has_profile (cp606 cache-aware: servedFromCache + queriedWithProfile), not row count',
	/const complete = servedFromCache \+ queriedWithProfile === accounts\.length/.test(flat),
	'row presence stopped meaning "has a profile" the moment the anchor moved; completeness must count positives (cached positives + freshly-queried has_profile rows), never a raw row count, or a profile-less batch is called complete and pinned for 90s, hiding a freshly-created profile (cp428 soft-null policy; cp606 made completeness cache-aware)'
);
check(
	'the query actually selects has_profile',
	/\(p\.account IS NOT NULL\) AS has_profile/.test(flat),
	'the completeness test needs a real per-row signal'
);
check(
	'a partial batch is still served no-store',
	/complete \? BATCH_CACHE_CONTROL : BATCH_CACHE_CONTROL_PARTIAL/.test(flat),
	'negative results must not be pinned in the browser cache'
);

console.log('\n' + '─'.repeat(58));
if (fail === 0) {
	console.log(`✓ all ${pass} profiles-batch-anchor scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
