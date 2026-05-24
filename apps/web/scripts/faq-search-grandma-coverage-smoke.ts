#!/usr/bin/env tsx
/**
 * Smoke: FAQ search returns sensible top results for Grandma's
 *        first-load questions.
 *
 * Anchor: cp137 deep-deep walkthrough finding H-2.  Before the
 * synonym additions, queries like "how do I start" returned
 * `order_editing` at score 1.00 — completely wrong — while the
 * actually-correct entry (`how_to_trade_walkthrough`) sat at #2.
 * "What is this" returned `feedback_immutable`, "how do I begin"
 * returned zero hits.
 *
 * This smoke asserts that, for a hand-curated set of grandma-shaped
 * questions, the TOP hit is one of an expected set of relevant
 * entries.  When the synonym map drifts in a future edit, this
 * fails with a clear message naming both the query and the wrong
 * top hit.
 *
 * Tamper test: revert the getting-started cluster from SYNONYMS_EN
 * and this fails on at least 3 queries.
 */

import { searchEntries, type FaqEntry } from '../src/lib/utils/faqIndex';
import enRaw from '../src/lib/i18n/locales/en.json' with { type: 'json' };

interface EnShape {
	faq: { entries: Record<string, { q: string; a: string }> };
}
const en = enRaw as unknown as EnShape;

const entries: FaqEntry[] = Object.entries(en.faq.entries).map(([key, v]) => ({
	key: key as FaqEntry['key'],
	question: v.q,
	answer: v.a,
	related: []
}));

interface Case {
	query: string;
	// The top hit must be one of these keys for the smoke to pass.
	// All keys named here must exist in the FAQ index (asserted up front).
	acceptableTopHits: readonly string[];
}

const CASES: readonly Case[] = [
	// Grandma's three classic first-load questions:
	{
		query: 'what is this',
		// Either the canonical morphit-intro OR a related "what is X"
		// is acceptable; the previous worst-case `feedback_immutable`
		// is not.
		acceptableTopHits: ['what_is_morphit', 'activity_level', 'node_hosting_costs']
	},
	{
		query: 'is my money safe',
		acceptableTopHits: ['is_it_safe']
	},
	{
		query: 'how do I start',
		acceptableTopHits: ['how_to_trade_walkthrough', 'signup_requirements', 'how_to_buy']
	},
	// Variants Grandma might type:
	{
		query: 'how do I begin',
		acceptableTopHits: ['how_to_trade_walkthrough', 'signup_requirements']
	},
	{
		query: 'first time user',
		acceptableTopHits: ['how_to_trade_walkthrough', 'new_trader_badge', 'signup_requirements']
	},
	{
		query: 'getting started',
		acceptableTopHits: ['how_to_trade_walkthrough', 'signup_requirements']
	},
	{
		query: 'beginner',
		acceptableTopHits: ['how_to_trade_walkthrough', 'new_trader_badge', 'signup_requirements']
	},
	{
		query: 'tutorial',
		acceptableTopHits: ['video_tutorial', 'how_to_trade_walkthrough']
	},
	{
		query: 'lost my password',
		acceptableTopHits: ['lost_keys']
	},
	{
		query: 'lost my keys',
		acceptableTopHits: ['lost_keys']
	},
	{
		query: 'do I need KYC',
		acceptableTopHits: ['kyc_requirement', 'is_it_safe', 'privacy_practices']
	},
	{
		query: 'how do I buy bitcoin',
		// Ambiguous — "bitcoin" matches both `how_to_buy` (generic
		// "buy crypto" guide) and `what_is_bch` (which has "Bitcoin"
		// prominently in its question text since BCH stands for
		// Bitcoin Cash).  Either is a legitimate first-hop for a
		// curious user; both lead the user where they need to be
		// via the related-chips.
		acceptableTopHits: ['how_to_buy', 'how_to_trade_walkthrough', 'what_is_bch']
	},
	{
		query: 'how do I sell monero',
		acceptableTopHits: ['how_to_sell', 'how_to_trade_walkthrough']
	}
];

let passes = 0;
let failures = 0;

function pass(msg: string): void {
	passes += 1;
	console.log(`  ✓ ${msg}`);
}
function fail(msg: string, detail = ''): void {
	failures += 1;
	console.error(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
}

console.log('faq-search-grandma-coverage-smoke\n');

// Verify every acceptableTopHits key actually exists in the index —
// otherwise the smoke would silently always-fail when an FAQ entry
// gets renamed.
const indexKeys = new Set(entries.map((e) => e.key as string));
const referencedKeys = new Set(CASES.flatMap((c) => c.acceptableTopHits));
const orphans = Array.from(referencedKeys).filter((k) => !indexKeys.has(k));
if (orphans.length > 0) {
	fail(
		`smoke references FAQ keys that don't exist in en.json: ${orphans.join(', ')}`,
		`Update CASES in this file to point at currently-shipped entry keys, or restore the missing entries.`
	);
} else {
	pass(`all ${referencedKeys.size} referenced FAQ keys exist in en.json`);
}

// Per-case checks
for (const { query, acceptableTopHits } of CASES) {
	const hits = searchEntries(entries, query, 1);
	if (hits.length === 0) {
		fail(`"${query}" returned ZERO hits`, `Synonym map needs an entry that maps this phrase's tokens to something in the FAQ.`);
		continue;
	}
	const top = hits[0];
	if ((acceptableTopHits as readonly string[]).includes(top.entry.key as string)) {
		pass(`"${query}" → [${top.entry.key}] (acceptable)`);
	} else {
		fail(
			`"${query}" top hit is [${top.entry.key}] (${top.entry.question})`,
			`Expected one of: ${acceptableTopHits.join(', ')}. ` +
				`Adjust SYNONYMS_EN in apps/web/src/lib/utils/faqIndex.ts so this query routes correctly.`
		);
	}
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} faq-search-grandma-coverage scenarios passed`);
