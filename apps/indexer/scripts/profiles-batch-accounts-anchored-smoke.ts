#!/usr/bin/env tsx
/*
 * profiles-batch-accounts-anchored — v1.5.5 (t155) guard.
 *
 * Ken: on the profile's review cards, the truncated posting key was missing
 * under @kentest2 while every other card showed theirs.
 *
 * ROOT CAUSE. `posting_pubkey` lives on `accounts`, but the batch query STARTED
 * at `profiles`:
 *
 *     FROM profiles p LEFT JOIN accounts a ON a.name = p.account
 *     WHERE p.account = ANY($1)
 *
 * An account that never set a display name or avatar has no `profiles` row, so
 * the batch returned NOTHING for them — key included. Every account WITH a
 * profile showed its key, which is exactly why this looked like a per-card bug
 * and wasn't. (The obvious suspect, `reviewerProfileMap`, was innocent: it
 * already adds subjects, and the card already passes the key through.)
 *
 * THE FIX IS NOT A ONE-LINE ANCHOR SWAP. Two traps ride with it, and this smoke
 * exists because both are silent:
 *
 *   1. rowToProfile CRASHES on a profile-less row. It called
 *      `updated_at.toISOString()` and `parseInt(source_block_num)`, safe only
 *      while the query could never return such a row. Now it can, on an
 *      endpoint shared by FeaturedOrders, the profile page and the orderbook.
 *
 *   2. NEGATIVE CACHING breaks silently. The endpoint serves partial batches
 *      `no-store` because "negative results must not be pinned" (cp428 soft-null
 *      policy). Once every known account returns a row, a row-COUNT test calls
 *      such a batch complete and pins it for 90s — so a user who sets their
 *      first profile stays invisible for a minute and a half. The completeness
 *      test must key off `has_profile`, not row presence.
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
	'the batch is anchored on accounts, not profiles',
	/FROM accounts a LEFT JOIN profiles p ON p\.account = a\.name/.test(flat),
	'posting_pubkey lives on `accounts`; anchoring on `profiles` returns NOTHING for an account that never set a display name — key included (Ken: no truncated key under @kentest2)'
);
check(
	'the batch filters on the accounts table',
	/WHERE a\.name = ANY\(\$1::text\[\]\)/.test(flat),
	'filtering on p.account would re-impose the profiles anchor through the back door'
);
check(
	'the old profiles-anchored BATCH shape is gone',
	!/FROM profiles p LEFT JOIN accounts a ON a\.name = p\.account WHERE p\.account = ANY/.test(flat),
	'the regressed batch query is still present'
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
	'batch completeness keys off has_profile, not row count',
	/const complete = result\.rows\.filter\(\(r\) => r\.has_profile\)\.length === accounts\.length/.test(
		flat
	),
	'row presence stopped meaning "has a profile" the moment the anchor moved; a row-count test would call a profile-less batch complete and pin it for 90s, hiding a freshly-created profile (cp428 soft-null policy)'
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
	console.log(`✓ all ${pass} profiles-batch-accounts-anchored scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
