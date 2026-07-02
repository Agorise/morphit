#!/usr/bin/env tsx
/**
 * apps/web/scripts/order-card-smoke.ts (cp404)
 *
 * Structural invariants over the shared OrderCard component and its two
 * call sites (orderbook results + profile active-orders). Locks the
 * pieces of Ken's redesign that are easy to regress:
 *
 *   • The reputation SCORE and the trade COUNT are separate signals
 *     (score ← reputation_score; count ← feedback_count via
 *     formatCountCompact) — never conflated.
 *   • Buyer/seller framing: side 'buy' → "I can pay with", 'sell' →
 *     "I accept".
 *   • "N trades since {month}" only when a first trade exists.
 *   • The whole card is a stretched link (z-0) with interactive
 *     children raised (z-10).
 *   • The posting key is shown via the centralized truncatePublicKey.
 *   • Existing signals preserved: expiry chip, new-trader chip,
 *     engagement chip, blocked/hidden markers.
 *   • Both call sites actually render <OrderCard> with the core props.
 *
 * Plus i18n parity: the 8 new orderbook.card.* keys exist in all 10
 * locales with their interpolation placeholders intact.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const read = (p: string) => readFileSync(resolve(WEB, p), 'utf8');

let total = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	total++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

const card = read('src/lib/components/OrderCard.svelte');

// ─── Reputation score vs trade count: separate signals ────────────
check(
	'1 reputation score rendered from reputation_score (not the raw rating)',
	/order\.reputation_score/.test(card) && /score\.toFixed\(2\)/.test(card)
);
check(
	'2 trade count rendered via formatCountCompact(feedback_count)',
	/formatCountCompact/.test(card) && /order\.feedback_count/.test(card)
);
check(
	'3 score and count are distinct (score has ⭐, count has its own line)',
	card.indexOf('reputation_score') !== card.indexOf('feedback_count') &&
		/⭐/.test(card)
);

// ─── Buyer / seller framing ───────────────────────────────────────
check(
	"4 side 'buy' → pay_with_label, else accept_label",
	/order\.side === 'buy'[\s\S]*orderbook\.card\.pay_with_label[\s\S]*orderbook\.card\.accept_label/.test(
		card
	)
);

// ─── "trades since {month}" gating ────────────────────────────────
check(
	'5 first_trade_at present → trades_since, absent → trades_only',
	/order\.first_trade_at[\s\S]*orderbook\.card\.trades_since[\s\S]*orderbook\.card\.trades_only/.test(
		card
	) && /formatMonthYear/.test(card)
);

// ─── Stretched link + z-index pattern ─────────────────────────────
check(
	'6 whole card is a stretched link at z-0',
	/href=\{detailHref\}/.test(card) && /absolute inset-0 z-0/.test(card)
);
check(
	'7 interactive children raised above the stretched link (z-10)',
	(card.match(/z-10/g) ?? []).length >= 3 // profile link, message button, eyeball
);

// ─── Posting key via the centralized truncation cache ─────────────
check(
	'8 posting key shown via truncatePublicKey(order.posting_pubkey)',
	/truncatePublicKey\(order\.posting_pubkey/.test(card)
);

// ─── Message button + eyeball gating ──────────────────────────────
check(
	'9 Message button hidden when messageHref null or hidden/blocked',
	/\{#if messageHref && !hidden && !blocked\}/.test(card)
);
check(
	'10 eyeball hidden when no toggle wired or account blocked',
	/\{#if onToggleHide && !blocked\}/.test(card)
);

// ─── Preserved / new signals (cp404 revision) ─────────────────────
check(
	'11 keeps expiry + new-trader chips',
	/OrderExpiryChip/.test(card) && /NewTraderChip/.test(card)
);
check(
	'11b engagement chip commented out, data preserved',
	// The import is commented (so it cannot be actively rendered —
	// svelte-check would fail otherwise), the "hidden per Ken" marker is
	// present, and engagement_24h still flows on the data model.
	/\/\/ import EngagementChip from/.test(card) &&
		/engagement_24h/.test(card) &&
		/hidden per Ken/.test(card)
);
check(
	'11c price-model subline shown under the expiry pill',
	/\{#if priceModelLabel\}/.test(card) && /\{priceModelLabel\}/.test(card)
);
check(
	'11d USDT peg subline shown for USDT orders',
	/order\.asset === 'USDT'/.test(card) && /UsdtPriceSubline/.test(card)
);
check(
	'12 blocked/hidden markers present, in the bottom-right cluster beside the eyeball',
	/orderbook\.blocked_marker/.test(card) &&
		/orderbook\.hidden_marker/.test(card) &&
		/absolute bottom-3 right-3 z-10 flex items-center gap-2/.test(card)
);
check(
	'13 reuses IdentityLabel for the avatar (hideHandle)',
	/IdentityLabel/.test(card) && /hideHandle/.test(card)
);

// ─── Both call sites render OrderCard ─────────────────────────────
const orderbook = read('src/routes/[lang]/orderbook/+page.svelte');
const profile = read('src/routes/[lang]/[x+40][account=account]/+page.svelte');
check(
	'14 orderbook page renders <OrderCard> with order + detailHref',
	/import OrderCard/.test(orderbook) &&
		/<OrderCard/.test(orderbook) &&
		/order=\{o\}/.test(orderbook) &&
		/detailHref=/.test(orderbook)
);
check(
	'15 profile page renders <OrderCard> with order + detailHref',
	/import OrderCard/.test(profile) &&
		/<OrderCard/.test(profile) &&
		/order=\{o\}/.test(profile) &&
		/detailHref=/.test(profile)
);
check(
	'16 old inline TermsText duplicate removed from both pages',
	!/TermsText/.test(orderbook) && !/TermsText/.test(profile),
	'the shared OrderCard owns terms rendering now'
);

// ─── i18n parity for the 8 new keys ───────────────────────────────
const LOCALES_DIR = resolve(WEB, 'src/lib/i18n/locales');
const NEW_KEYS = [
	'pay_with_label',
	'accept_label',
	'location_label',
	'terms_label',
	'trades_since',
	'trades_only',
	'reputation_aria',
	'message_word'
];
const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
check('17 found the 10 expected locales', localeFiles.length === 10, `found ${localeFiles.length}`);

for (const lf of localeFiles) {
	const loc = lf.replace('.json', '');
	const d = JSON.parse(readFileSync(join(LOCALES_DIR, lf), 'utf8')) as {
		orderbook?: { card?: Record<string, string> };
	};
	const cardKeys = d.orderbook?.card ?? {};
	const missing = NEW_KEYS.filter((k) => typeof cardKeys[k] !== 'string' || cardKeys[k].length === 0);
	check(`18.${loc} has all 8 orderbook.card keys`, missing.length === 0, `missing: ${missing.join(', ')}`);
	// placeholder integrity
	const since = cardKeys['trades_since'] ?? '';
	check(
		`19.${loc} trades_since keeps {count} and {month}`,
		since.includes('{count}') && since.includes('{month}'),
		since
	);
	const aria = cardKeys['reputation_aria'] ?? '';
	check(`20.${loc} reputation_aria keeps {score}`, aria.includes('{score}'), aria);
}

console.log('');
if (failed > 0) {
	console.log(`\u2717 ${failed}/${total} order-card scenarios failed`);
	process.exit(1);
}
console.log(`\u2713 all ${total} order-card scenarios passed`);
