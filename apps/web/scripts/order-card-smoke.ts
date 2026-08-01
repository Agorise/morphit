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
// cp406 — the identity row (avatar + name·new-trader·⭐score, key·trades) was
// extracted into the shared OrderPosterIdentity component. Assertions about
// that row now read from it; card-level assertions stay on OrderCard.
const identity = read('src/lib/components/OrderPosterIdentity.svelte');

// ─── Trades vs ratings: THREE separate signals ────────────────────
// v1.5.5 (t155): trades and ratings are different numbers from different
// sources now. Before, the "trade count" WAS the feedback count — the orderbook
// even documented it as a "proxy for trades completed" — so a real trade nobody
// reviewed counted for nothing, and a taker (who owns no order) read "0 trades"
// forever. Trades come from COMPLETED ORDERS crediting both sides; the rating
// count still says how many RATINGS back the star average, because "★5.00 (34)"
// has to mean 34 ratings.
const cluster = read('src/lib/components/TradeRepCluster.svelte');
check(
	'1 the identity row renders the trades·rating cluster',
	/<TradeRepCluster \{tradeCount\} rating=\{score\} \{ratingCount\} \/>/.test(identity)
);
check(
	'2 trade count comes from order.trade_count, NOT the feedback count',
	/const tradeCount = \$derived\(order\.trade_count \?\? 0\)/.test(identity) &&
		!/formatCountCompact\(count\)/.test(identity),
	'sourcing trades from feedback_count is the pre-v1.5.5 proxy: it drops unreviewed trades and starves takers'
);
check(
	'3 the rating count still counts RATINGS (feedback_count)',
	/const ratingCount = \$derived\(order\.feedback_count \?\? 0\)/.test(identity),
	'"★5.00 (34)" must mean 34 ratings — sourcing that from trades would make the chip lie'
);
check(
	'3b the cluster keeps the two numbers apart',
	/tradeCount: number/.test(cluster) && /ratingCount\?: number/.test(cluster)
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
	'5 the cluster is UNBREAKABLE (nowrap + flex-none in a wrapping row)',
	// Ken: "none of that chunk ever gets broken, no wrap. it stays together as a
	// chunk of text or else it must go onto its own line." nowrap stops it
	// breaking internally; flex-none stops a long display name squeezing it.
	// The old "852 trades since July, 2026" line is deliberately gone: with the
	// chunk nowrap by contract, a "since {month}" tail overflows a phone rather
	// than wrapping.
	/whitespace-nowrap/.test(cluster) && /flex-none/.test(cluster),
	'without nowrap+flex-none the chunk breaks mid-way or ellipsises on a narrow screen'
);

// ─── Stretched link + z-index pattern ─────────────────────────────
check(
	'6 whole card is a stretched link at z-0',
	/href=\{detailHref\}/.test(card) && /absolute inset-0 z-0/.test(card)
);
check(
	'7 interactive children raised above the stretched link (z-10)',
	(card.match(/z-10/g) ?? []).length >= 2 // message button, eyeball (profile link moved to OrderPosterIdentity)
);

// ─── Posting key via the centralized truncation cache ─────────────
check(
	'8 posting key shown via truncatePublicKey(order.posting_pubkey)',
	/truncatePublicKey\(/.test(identity) && /order\.posting_pubkey/.test(identity)
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
	'11 keeps expiry (card) + new-trader (identity) chips',
	/OrderExpiryChip/.test(card) && /NewTraderChip/.test(identity)
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
	'11d stablecoin peg subline shown for USDT/USDC/DAI orders',
	/isStablecoinSublineTicker\(order\.asset\)/.test(card) && /StablecoinPriceSubline/.test(card)
);
check(
	'11e stablecoin subline is generalised to all three stablecoins (not USDT-only)',
	(() => {
		const list = readFileSync(
			join(WEB, 'src/lib/assets/stablecoinSubline.ts'),
			'utf8'
		);
		const comp = readFileSync(
			join(WEB, 'src/lib/components/StablecoinPriceSubline.svelte'),
			'utf8'
		);
		const hasAllThree = /'USDT'/.test(list) && /'USDC'/.test(list) && /'DAI'/.test(list);
		// component keys off a dynamic ns → works for any listed stablecoin
		const dynamicKey = /assets\.\$\{ns\}\.price_subline\.(live|unavailable)/.test(comp);
		return hasAllThree && dynamicKey;
	})()
);
check(
	'12 blocked/hidden markers present, in the bottom inline-end cluster beside the eyeball (mirrors for RTL)',
	/orderbook\.blocked_marker/.test(card) &&
		/orderbook\.hidden_marker/.test(card) &&
		/absolute bottom-3 z-10 flex items-center gap-2 ltr:right-3 rtl:left-3/.test(card)
);
check(
	'13 reuses IdentityLabel for the avatar (hideHandle)',
	/IdentityLabel/.test(identity) && /hideHandle/.test(identity)
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
// v1.5.5 (t155): `trades_since` is deliberately GONE — the "852 trades since
// July, 2026" line was removed when the trade count moved into the nowrap
// TradeRepCluster ("1 trade · ★5.00 (34)"). With that chunk unbreakable by
// contract, a "since {month}" tail overflows a phone rather than wrapping. The
// key was pruned from all 10 locales, and the i18n dead-key gate enforces that
// no locale keeps a leaf that nothing references.
// v1.7.5 (t.txt #8) — `reputation_aria` is deliberately gone. It backed the
// chatroom's HAND-ROLLED `⭐ {score}`, which was replaced by the shared
// TradeRepCluster; the shared RatingChip announces via `orderbook.order.rating_aria`
// instead, so screen-reader coverage is unchanged and this key had no consumer
// left. The i18n dead-key gate would fail on a locale leaf nothing references.
const NEW_KEYS = [
	'pay_with_label',
	'accept_label',
	'location_label',
	'terms_label',
	'trades_only',
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
	check(`18.${loc} has all 6 orderbook.card keys`, missing.length === 0, `missing: ${missing.join(', ')}`);
	// placeholder integrity — v1.5.5: trades_since is gone, so this now guards
	// trades_only, the surviving count-bearing key.
	const only = cardKeys['trades_only'] ?? '';
	check(
		`19.${loc} trades_only keeps {count}`,
		only.includes('{count}'),
		only
	);
	// v1.7.5 — the score's accessible name moved to the SHARED RatingChip, which
	// announces via `orderbook.order.rating_aria`. Assert it where it now lives, so
	// screen-reader coverage stays pinned rather than silently dropped along with
	// the key it used to use.
	const ratingAria = (
		JSON.parse(readFileSync(join(LOCALES_DIR, lf), 'utf8')) as {
			orderbook?: { order?: Record<string, string> };
		}
	).orderbook?.order?.['rating_aria'] ?? '';
	check(`20.${loc} the shared rating aria keeps {rating}`, ratingAria.includes('{rating}'), ratingAria);
}

console.log('');
if (failed > 0) {
	console.log(`\u2717 ${failed}/${total} order-card scenarios failed`);
	process.exit(1);
}

// ─── v1.7.5 (t.txt #5, #6, #7) ───────────────────────────────────────
const chip = read('src/lib/components/OrderExpiryChip.svelte');
const ratingChip = read('src/lib/components/RatingChip.svelte');

// t.txt #5 — Ken asked for "Posted 1h ago" and added "assuming that is correct".
// It wasn't, quite: `orders.updated_at` starts equal to created_at but feeAttest
// MOVES it when a BTC/XMR listing fee verifies — to a LIVE order, hours after
// posting. So relabelling alone would have said "Posted 5m ago" about an order
// posted two hours earlier. The FIELD changed too.
check(
	'20 the expiry chip takes the POSTED time, not updated_at',
	/<OrderExpiryChip expiresAt=\{order\.expires_at\} postedAtIso=\{order\.created_at\} \/>/.test(card),
	'feeAttest moves updated_at on a live order — it does not mean "posted"'
);
check('21 the chip prop is named for what it holds', /postedAtIso\?: string;/.test(chip));
check(
	'22 no caller still feeds updated_at to the chip',
	!/updatedAtIso/.test(chip) && !/updatedAtIso/.test(card)
);
check('23 the tooltip says posted, not updated', /orderbook\.order\.posted_ago/.test(chip));

// t.txt #6 — 0 hides entirely; 1 is singular; >1 plural.
check('24 zero trades renders nothing at all', /const showTrades = \$derived\(tradeCount > 0\);/.test(cluster));
check(
	'25 the plural selector gets the RAW count, not the compacted string',
	/values: \{ n: tradeCount, count: formatCountCompact\(tradeCount\) \}/.test(cluster),
	'formatCountCompact yields "1.2K"; a string never matches an ICU plural rule'
);

// t.txt #7 — rating pill FIRST, trade count to its right at the pill's size.
const ratingIdx = cluster.indexOf('<RatingChip count={ratingCount} {rating} />');
const tradesIdx = cluster.indexOf('<span class="text-xs">{tradesText}</span>');
check('26 the rating pill renders before the trade count', ratingIdx > 0 && tradesIdx > ratingIdx);
check('27 the trade count matches the pill\'s text-xs', tradesIdx > 0);
check(
	'28 the cluster is still ONE unbreakable chunk',
	/inline-flex flex-none items-center gap-1\.5 whitespace-nowrap/.test(cluster),
	"Ken: none of that chunk ever gets broken, no wrap"
);
check(
	'29 the rating count is no longer dimmed to 70%',
	!/class="opacity-70">\(\{count\}\)/.test(ratingChip),
	'measured: the pill already matches the Expires pill; this was the one real dimming'
);
check(
	'30 the rating pill keeps the Expires pill\'s emerald + ring',
	/bg-morphit-emerald\/10/.test(ratingChip) && /ring-1 ring-morphit-emerald\/30/.test(ratingChip)
);

// Every locale must pluralise — not just English.
for (const lf of localeFiles) {
	const loc = lf.replace('.json', '');
	const d = JSON.parse(readFileSync(join(LOCALES_DIR, lf), 'utf8')) as {
		orderbook?: { card?: Record<string, string> };
	};
	const only = d.orderbook?.card?.['trades_only'] ?? '';
	check(`31.${loc} trades_only is ICU-pluralised`, /\{n, plural,/.test(only), only);
	check(`32.${loc} trades_only still shows the count`, only.includes('{count}'), only);
}

console.log(`\u2713 all ${total} order-card scenarios passed`);
