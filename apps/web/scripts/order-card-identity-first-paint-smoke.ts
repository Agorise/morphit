#!/usr/bin/env tsx
/**
 * order-card-identity-first-paint — v1.8.13 (Ken).
 *
 * KEN'S REQUIREMENT, VERBATIM: "i should NEVER see the default username and
 * identicon if a custom display name and custom avatar have been set."
 *
 * THE BUG. The orderbook returned `posting_pubkey` inline but not the profile,
 * so the browser fetched names and avatars in a SECOND round-trip. Cards
 * painted `@account` + identicon and swapped to the real identity seconds later
 * — ~7s on morphit.io.
 *
 * WHY THAT IS A TRUST DEFECT, NOT A PERFORMANCE ONE. Ken: "if i were an
 * interested user in that order, i would think twice because it looks like i
 * might get scammed when that user's ordercard seems like it can just change
 * itself on the fly like that." On a marketplace where the counterparty's
 * identity IS the product, an identity that visibly rewrites itself is
 * indistinguishable from a swap attack. Fixing it by making the swap FASTER
 * would not fix it; the swap has to not happen.
 *
 * THE FIX. `profiles` is LEFT JOINed into the orderbook query, so a row arrives
 * carrying its own display name and avatar and the card is correct on first
 * paint. The client still prefers the hydrated map when present (it is fresher,
 * e.g. a profile edited after page load), and an older indexer that omits the
 * inline fields degrades to exactly the previous behaviour.
 *
 * Tamper tests (each must turn this red):
 *   - Drop the profiles join or the selected columns from the query.
 *   - Stop the card consulting the inline profile.
 *   - Remove the fields from OrderRecord.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

const orderbookApi = read('apps/indexer/src/api/orderbook.ts');
const joins = read('apps/indexer/src/api/reputationJoin.ts');
const client = read('packages/indexer-client/src/index.ts');
const page = read('apps/web/src/routes/[lang]/orderbook/+page.svelte');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── order-card-identity-first-paint (v1.8.13) ─────────\n');

// v1.8.14 (Ken) — EVERY query that builds an order row must join profiles, not
// just the one I happened to fix. v1.8.13 added it to the REST orderbook query
// only; `orderbookStream.ts` (the LIVE feed) and `featuredOrderbook.ts` were
// missed, so orders arriving or refreshing through those paths still painted
// @account + identicon and swapped. Ken: "it STILL takes 5-6 seconds... not all
// of the time, but half of the time or so" — the intermittency WAS the tell:
// different rows arrived by different paths.
// `accountsJoin` marks a query that builds order rows, so it is the anchor:
// wherever it appears, `profileJoin` must too.
const ORDER_ROW_QUERIES = [
	'apps/indexer/src/api/orderbook.ts',
	'apps/indexer/src/api/orderbookStream.ts',
	'apps/indexer/src/api/featuredOrderbook.ts'
];
for (const q of ORDER_ROW_QUERIES) {
	const qs = readFileSync(join(REPO, q), 'utf8');
	const name = q.split('/').pop()!;
	check(
		`${name}: joins profiles wherever it joins accounts`,
		!/accountsJoin\(/.test(qs) || /profileJoin\(/.test(qs),
		'an order row without inline identity paints @account + identicon, then swaps'
	);
	check(
		`${name}: selects the display name and avatar metadata`,
		!/accountsJoin\(/.test(qs) || (/pr\.display_name/.test(qs) && /profile_json_metadata/.test(qs)),
		'joined but unselected is the same as not joined'
	);
}

check(
	'a profiles join helper exists',
	/export function profileJoin\(/.test(joins),
	'without it the identity needs a second round-trip'
);
check(
	'the orderbook query JOINs profiles',
	/\$\{profileJoin\('o', 'pr'\)\}/.test(orderbookApi),
	'the row cannot carry an identity it never selected'
);
check(
	'…and selects the display name',
	/pr\.display_name/.test(orderbookApi),
	'the card would fall back to @account'
);
check(
	'…and the profile metadata that holds the avatar',
	/pr\.json_metadata AS profile_json_metadata/.test(orderbookApi),
	'the card would fall back to the identicon'
);
check(
	'both are returned in the response row',
	/display_name: r\.display_name \?\? null/.test(orderbookApi) &&
		/profile_json_metadata: r\.profile_json_metadata \?\? null/.test(orderbookApi),
	'selected but not returned is the same as not selected'
);
check(
	'OrderRecord carries them, so the client can use them',
	/readonly display_name\?: string \| null;/.test(client) &&
		/readonly profile_json_metadata\?: unknown;/.test(client),
	'an untyped field will not be read'
);
check(
	'the card renders from the inline profile when the hydrated map is empty',
	/profileMap\[o\.account\] \?\? inlineProfileOf\(o\)/.test(page),
	'THE WHOLE POINT: without this the first paint is still @account + identicon'
);
check(
	'the hydrated map still takes precedence when present',
	/profileMap\[o\.account\] \?\? /.test(page),
	'a profile edited after page load must still win over the row snapshot'
);
check(
	'the inline adapter degrades safely on an older indexer',
	/if \(o\.display_name === undefined && o\.profile_json_metadata === undefined\) return null;/.test(
		page
	),
	'an instance that omits the fields must fall back, not render blanks'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} order-card-identity-first-paint checks passed` : '✗ order-card-identity-first-paint FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
