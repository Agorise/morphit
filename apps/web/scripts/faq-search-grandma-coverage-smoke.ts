#!/usr/bin/env tsx
/**
 * Smoke: FAQ search returns sensible top results for Grandma's
 *        first-load questions.
 *
 * Anchor: deep walkthrough finding H-2.  Before the
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

import { FAQ_KEYS, FAQ_RELATED, searchEntries, type FaqEntry } from '../src/lib/utils/faqIndex';
import enRaw from '../src/lib/i18n/locales/en.json' with { type: 'json' };
import { applyBrandToString } from '../../../packages/operator-config/src/brand.ts';

interface EnShape {
	faq: { entries: Record<string, { q: string; a: string }> };
}
const en = enRaw as unknown as EnShape;

// The FAQ names the SITE with `{brand}` (docs/BRANDING.md); the browser fills
// it in before anyone searches. So search what a visitor sees: an unbranded
// site ("Morphit") and a branded one, whose name the search is told (v1.21.6).
const BRANDED = 'Vigilante Trading';
function entriesFor(brand: string | null): FaqEntry[] {
	const fill = (s: string): string =>
		applyBrandToString(s, (form) => (brand === null ? form : brand));
	return Object.entries(en.faq.entries).map(([key, v]) => ({
		key: key as FaqEntry['key'],
		question: fill(v.q),
		answer: fill(v.a),
		related: []
	}));
}
const entries: FaqEntry[] = entriesFor(null);
const brandedEntries: FaqEntry[] = entriesFor(BRANDED);

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
	},
	// Settings → Offline Notifications. A question about the feature by name,
	// or about the address she gave it, lands on its own article; a general
	// "tell me by email / on Telegram" may land on the notifications overview,
	// which points to it. ("notify me by email" found nothing at all until
	// "notify" had synonyms and "by"/"me" were filler words.)
	{ query: 'offline notifications', acceptableTopHits: ['offline_notifications'] },
	{ query: 'is my email address private', acceptableTopHits: ['offline_notifications'] },
	{ query: 'how do i stop the notes', acceptableTopHits: ['offline_notifications'] },
	{
		query: 'notify me by email',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	{
		query: 'telegram notifications',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	{
		query: 'get a message on telegram when someone writes',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	// "notified" and "writes" once also expanded to "note", a word common
	// enough ("a short note about using it" on profiles) that these landed on
	// the iPhone, profile and blocking answers.
	{
		query: 'how do i get notified',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	{
		query: 'someone writes to me',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	{
		query: 'when someone writes',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
	},
	{
		query: 'how do i know if someone writes to me',
		acceptableTopHits: ['notifications_overview', 'offline_notifications']
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

// Per-case checks, on an unbranded site and on a branded one.
for (const [site, list, name] of [
	['unbranded', entries, undefined],
	[`branded "${BRANDED}"`, brandedEntries, BRANDED]
] as const) {
	for (const { query, acceptableTopHits } of CASES) {
		const hits = searchEntries(list, query, 1, name);
		if (hits.length === 0) {
			fail(
				`${site}: "${query}" returned ZERO hits`,
				`Synonym map needs an entry that maps this phrase's tokens to something in the FAQ.`
			);
			continue;
		}
		const top = hits[0];
		if ((acceptableTopHits as readonly string[]).includes(top.entry.key as string)) {
			pass(`${site}: "${query}" → [${top.entry.key}] (acceptable)`);
		} else {
			fail(
				`${site}: "${query}" top hit is [${top.entry.key}] (${top.entry.question})`,
				`Expected one of: ${acceptableTopHits.join(', ')}. ` +
					`Adjust SYNONYMS_EN in apps/web/src/lib/utils/faqIndex.ts so this query routes correctly.`
			);
		}
	}
}

// A site whose name holds a word that is also an FAQ topic ("Bitcoin Barter"):
// only the WHOLE name asks what the site is; one of its words asks about that
// topic ("what is barter" is the barter entry, not the site's introduction).
const TOPICAL = 'Bitcoin Barter';
const topicalEntries = entriesFor(TOPICAL);
for (const [query, want] of [
	['what is barter', 'what_is_barter'],
	['what is bitcoin barter', 'what_is_morphit'],
	['what is this site', 'what_is_morphit']
] as const) {
	const top = searchEntries(topicalEntries, query, 1, TOPICAL)[0];
	if (top?.entry.key === want) pass(`branded "${TOPICAL}": "${query}" → [${want}]`);
	else
		fail(
			`branded "${TOPICAL}": "${query}" top hit is [${top?.entry.key ?? 'none'}]`,
			`Expected ${want}.`
		);
}

// A brand made of everyday words must not bury the answers about those words:
// the FAQ names the site in ~120 answers, so "escrow" on "Escrow Shop" used to
// rank every answer that names the site above the one about escrow. Searching
// on a branded site finds what an unbranded site finds.
for (const [brand, query] of [
	['Escrow Shop', 'escrow'],
	['Escrow Shop', 'what is escrow'],
	['Monero Market', 'what is monero'],
	['Bitcoin Exchange', 'what is bitcoin'],
	['Wallet Swap', 'what is a wallet']
] as const) {
	const want = searchEntries(entries, query, 1)[0]?.entry.key ?? 'none';
	const got = searchEntries(entriesFor(brand), query, 1, brand)[0]?.entry.key ?? 'none';
	if (got === want) pass(`branded "${brand}": "${query}" → [${got}] (as unbranded)`);
	else fail(`branded "${brand}": "${query}" top hit is [${got}]`, `Unbranded finds ${want}.`);
}

// The site runs Morphit and says so, so a visitor may type "Morphit" on a
// branded site: that query must still find its entry there. And "what is this
// platform about" is the introduction, branded or not.
for (const [list, name, query, want] of [
	[entries, undefined, 'what is this platform about', 'what_is_morphit'],
	[brandedEntries, BRANDED, 'what is this platform about', 'what_is_morphit'],
	[entriesFor('Escrow Shop'), 'Escrow Shop', 'what is escrow shop', 'what_is_morphit'],
	[brandedEntries, BRANDED, 'how does morphit stop fake reviews', 'sybil_protection'],
	[brandedEntries, BRANDED, 'how much activity is there on morphit right now', 'activity_level'],
	[
		brandedEntries,
		BRANDED,
		'how do i build a high reputation score on morphit',
		'how_to_build_high_reputation'
	],
	[brandedEntries, BRANDED, 'does morphit chat have forward secrecy', 'forward_secrecy']
] as const) {
	const top = searchEntries(list as FaqEntry[], query, 1, name)[0];
	const site = name === undefined ? 'unbranded' : `branded "${name}"`;
	if (top?.entry.key === want) pass(`${site}: "${query}" → [${want}]`);
	else fail(`${site}: "${query}" top hit is [${top?.entry.key ?? 'none'}]`, `Expected ${want}.`);
}

// Filler words ("by", "me", "am", "at"): no answer needs them to match, and
// counted as words they push the right answer down or out. "notify me by
// email" kept only the overview while "by" was a word (the offline
// notifications answer never says "by"), and put an unrelated answer second
// while "me" was one; "i am lost" found a stablecoin network answer, and "how
// do i pay at the bank" the page about where to buy BLURT.
for (const [query, wantTop] of [
	['notify me by email', ['notifications_overview', 'offline_notifications']],
	['notify me by telegram', ['notifications_overview', 'offline_notifications']],
	['i am lost', ['lost_keys']],
	['how do i pay at the bank', ['in_person_vs_online']]
] as const) {
	for (const [site, list, name] of [
		['unbranded', entries, undefined],
		[`branded "${BRANDED}"`, brandedEntries, BRANDED]
	] as const) {
		const got = searchEntries(list, query, wantTop.length, name).map((h) => h.entry.key as string);
		if (wantTop.every((k) => got.includes(k)))
			pass(`${site}: "${query}" → [${got.join(', ')}] (filler words ignored)`);
		else
			fail(
				`${site}: "${query}" top ${wantTop.length} is [${got.join(', ')}]`,
				`Expected ${wantTop.join(' and ')}: is a filler word (by/me/am/at) missing from STOPWORDS_EN?`
			);
	}
}

// Every key the FAQ links between (FAQ_RELATED) and every key it lists
// (FAQ_KEYS) is an entry of en.json: a "See also" chip or a search hit that
// names a missing entry shows a raw key, or nothing.
{
	const enKeys = new Set(Object.keys(en.faq.entries));
	const missing = new Set<string>();
	for (const k of FAQ_KEYS) if (!enKeys.has(k)) missing.add(`FAQ_KEYS:${k}`);
	for (const [k, rel] of Object.entries(FAQ_RELATED)) {
		if (!enKeys.has(k)) missing.add(`FAQ_RELATED:${k}`);
		for (const r of rel ?? []) if (!enKeys.has(r)) missing.add(`FAQ_RELATED.${k}→${r}`);
	}
	if (missing.size === 0)
		pass(`every FAQ_KEYS and FAQ_RELATED key (${FAQ_KEYS.length} entries) exists in en.json`);
	else fail(`FAQ keys missing from en.json: ${[...missing].join(', ')}`);
	const offline = FAQ_RELATED.offline_notifications ?? [];
	if (
		offline.includes('notifications_overview') &&
		(FAQ_RELATED.notifications_overview ?? []).includes('offline_notifications')
	)
		pass('offline notifications and the notifications overview link to each other');
	else fail('offline_notifications ↔ notifications_overview "See also" link is missing');
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} faq-search-grandma-coverage scenarios passed`);
