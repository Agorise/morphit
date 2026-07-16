#!/usr/bin/env tsx
/*
 * trade-count-semantics — v1.5.5 (t155) guard.
 *
 * Ken's model: "if an order was marked as completed (not canceled or expired),
 * then imo that counts as 1 completed trade even if no stars were left."
 *
 * WHAT THIS EXISTS FOR. Before v1.5.5 there WAS no trade data, so every
 * trade-shaped thing in the API used the FEEDBACK count as a stand-in. The
 * orderbook said so outright: "Number of feedback rows received by this
 * account. Proxy for 'trades completed where this account was a party.'"
 *
 * v1.5.5 introduced real completions — and a proxy that is only half-replaced is
 * worse than one that isn't, because the two numbers then disagree under the
 * same name:
 *
 *   - the card renders "3 trades" from the REAL count, while
 *   - min_trades=3 filters that trader OUT because they have 2 reviews, and
 *   - sort=trades ranks an unreviewed veteran below a chatty novice, and
 *   - 🌱 means "<4 trades" on my/orders but "<4 reviews" on the orderbook.
 *
 * So: every trade-shaped surface must read the TRADE count, and every
 * rating-shaped surface must keep reading the FEEDBACK count. They are
 * different numbers on purpose.
 *
 * cp473 — THIS GUARD SHIPPED THE BUG IT WAS WRITTEN TO PREVENT. It asserted
 * "both endpoints expose trade_count", meaning orderbook.ts + orders.ts — but
 * FOUR endpoints feed the shared order card, and the two it never looked at
 * were still on the proxy:
 *
 *   - /v1/orderbook/stream — no trade_count at all, is_new_trader + min_trades
 *     still on f.c. Worse than merely stale: the orderbook page's onSnapshot
 *     comments say "Snapshot is authoritative: replace the live-page portion of
 *     items", so the stream OVERWRITES the REST rows a moment after load. The
 *     correct numbers were fetched, rendered, and then wiped.
 *   - /v1/orderbook/featured — same, on the cards a stranger is most likely to
 *     click.
 *
 * Proven against real Postgres 16 at cp473: on identical data the two
 * semantics are exactly INVERTED — a 5-trade/0-review veteran reads
 * is_new_trader=TRUE under f.c and FALSE under tc.c; a 0-trade/9-review novice
 * reads the reverse. So the sprout wasn't just stale on those surfaces, it was
 * backwards.
 *
 * The lesson is encoded below as a NEGATIVE, repo-wide check rather than another
 * hand-kept list: no file under src/api may derive is_new_trader from the
 * feedback count. A list of surfaces goes stale the moment someone adds the
 * fifth; the negative check fails automatically.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
	readFileSync(resolve(HERE, '..', rel), 'utf8').replace(/\s+/g, ' ');

const orderbook = read('src/api/orderbook.ts');
const orders = read('src/api/orders.ts');
const join = read('src/api/reputationJoin.ts');
// cp473 — the two surfaces the original guard never looked at.
const stream = read('src/api/orderbookStream.ts');
const streamHelpers = read('src/api/orderbookStreamHelpers.ts');
const featured = read('src/api/featuredOrderbook.ts');

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

// ── trade-shaped surfaces must use the TRADE count ──────────────────
check(
	'orderbook: is_new_trader keys off trade_count',
	/\(COALESCE\(tc\.c, 0\) < 4\) AS is_new_trader/.test(orderbook),
	'🌱 would mean "<4 reviews" here and "<4 trades" on my/orders — the same chip meaning two things'
);
check(
	'owner view: is_new_trader keys off trade_count',
	/\(COALESCE\(tc\.c, 0\) < 4\) AS is_new_trader/.test(orders),
	'the two endpoints must agree on what "new trader" means'
);
check(
	'orderbook: min_trades filters trade_count',
	/COALESCE\(tc\.c, 0\) >= \$\{p\(q\.min_trades\)\}/.test(orderbook),
	'a filter called min_TRADES that reads the feedback count contradicts the count shown on the very same card'
);
check(
	'orderbook: sort=trades orders by trade_count',
	/orderBy = 'COALESCE\(tc\.c, 0\) DESC/.test(orderbook),
	'"most experienced first" must mean most TRADES, or an unreviewed veteran sorts below a chatty novice'
);
check(
	'orderbook: the sort=trades SEEK matches its ORDER BY',
	/\(COALESCE\(tc\.c, 0\) < \$\{cParam\}/.test(orderbook),
	'the cursor seek and the ORDER BY must key off the SAME column or pagination silently skips/repeats rows'
);
check(
	'orderbook: the cursor mints a mode-appropriate seek key',
	/c: sort === 'trades' \? last\.trade_count : last\.feedback_count/.test(orderbook),
	'sort=rating tiebreaks on the FEEDBACK count while sort=trades is primary-keyed on the TRADE count; minting one for both compares a rating count against a trade count'
);

// ── the count itself ────────────────────────────────────────────────
check(
	'both polled endpoints expose trade_count on the wire',
	/trade_count: r\.trade_count/.test(orderbook) && /trade_count: r\.trade_count/.test(orders),
	'the order card reads order.trade_count wherever it renders; an endpoint that omits it silently shows "no trades"'
);

// ── cp473: ALL FOUR order-card surfaces, not just the polled two ────
// The shared OrderPosterIdentity reads `order.trade_count ?? 0` and
// TradeRepCluster hides the trade half when that is 0. So an endpoint that
// omits the column doesn't error — it silently renders a veteran as having
// never traded.
check(
	'SSE stream: is_new_trader keys off trade_count',
	/\(COALESCE\(tc\.c, 0\) < 4\) AS is_new_trader/.test(stream),
	'the orderbook page treats the stream snapshot as AUTHORITATIVE and replaces the REST rows with it, so a stream still on f.c does not merely go stale — it overwrites correct cards with the proxy semantics'
);
check(
	'SSE stream: emits trade_count on the wire',
	/COALESCE\(tc\.c, 0\)::int AS trade_count/.test(stream) &&
		/trade_count: r\.trade_count/.test(streamHelpers),
	'the live orderbook would render every card as "no trades" the instant the snapshot lands'
);
check(
	'SSE stream: carries the canonical trade-count join',
	/\$\{tradeCountJoin\('o'\)\}/.test(stream),
	'tc.c cannot resolve without the join; a hand-copied aggregate here is what let the feedback exclusions drift on this file already'
);
check(
	'SSE stream: min_trades filters trade_count, matching REST',
	/COALESCE\(tc\.c, 0\) >= \$\{p\(q\.min_trades\)\}/.test(streamHelpers),
	'the same min_trades value must select the same traders over REST and the stream — the stream snapshot is the one the user ends up looking at'
);
check(
	'featured strip: carries the trade-count join',
	/tradeCountJoin\('o', 'tc', 'SELECT bidder FROM winning_bids'\)/.test(featured),
	'featured cards render through the SHARED OrderCard, so a missing join blanks the trade count on exactly the cards a stranger is most likely to click'
);
check(
	'featured strip: scopes its trade aggregate like its feedback aggregate',
	/tradeCountJoin\('o', 'tc', 'SELECT bidder FROM winning_bids'\)/.test(featured) &&
		/feedbackAggregateJoin\('o', 'SELECT bidder FROM winning_bids'\)/.test(featured),
	'/v1/orderbook/featured is polled by every homepage visitor and returns at most 3 rows; counting every completed order on the instance there is real cost for no benefit — the reason feedbackAggregateJoin grew a scope in the first place'
);
check(
	'the shared select columns emit trade_count for every caller',
	/COALESCE\(\$\{tradeAlias\}\.c, 0\)::int AS trade_count/.test(join) &&
		/\(COALESCE\(\$\{tradeAlias\}\.c, 0\) < 4\) AS is_new_trader/.test(join),
	'reputationSelectColumns is what the featured strip uses; leaving IT on the feedback proxy is how that surface kept shipping pre-v1.5.5 semantics after the two hand-edited queries were fixed'
);

// ── the drift-proof negative: no surface may derive 🌱 from reviews ──
// A hand-kept list of surfaces goes stale the moment a fifth is added. This
// scans the whole API dir, so a new order-card endpoint that copies the old
// pattern fails without anyone remembering to update this file.
const apiDir = resolve(HERE, '..', 'src/api');
const proxyOffenders = readdirSync(apiDir)
	.filter((f) => f.endsWith('.ts'))
	.filter((f) =>
		/\(COALESCE\(f\.c, 0\) < 4\)\s*AS is_new_trader/.test(
			readFileSync(resolve(apiDir, f), 'utf8').replace(/\s+/g, ' ')
		)
	);
check(
	'NO api surface derives is_new_trader from the feedback count',
	proxyOffenders.length === 0,
	`still on the retired proxy: ${proxyOffenders.join(', ')} — proven at cp473 against real Postgres to INVERT the sprout (a 5-trade/0-review veteran reads "new"; a 0-trade/9-review novice reads "experienced")`
);

check(
	'trade credit goes to BOTH parties of a completed order',
	/UNION ALL/.test(join) && /o\.completed_counterparty AS account, o\.account AS peer/.test(join),
	'without the second half only ORDER OWNERS ever accrue trades — a taker owns no order and would read "0 trades" forever'
);
check(
	'a completed order counts even with no review',
	/WHERE o\.status = 'completed'/.test(join) && !/JOIN feedback/.test(join.split('TRADE_COUNT_SQL')[1] ?? ''),
	"Ken: a completion counts as 1 trade even if no stars were left — the count must not be gated on feedback"
);

// ── rating-shaped surfaces must NOT drift onto the trade count ──────
check(
	'the rating average still counts RATINGS',
	/ROUND\( SUM\(rating \*/.test(join) && /GROUP BY subject/.test(join),
	'"★5.00 (34)" must mean 34 ratings; sourcing that count from trades would make the chip lie'
);
check(
	'sort=rating still tiebreaks on the feedback count',
	/orderBy = 'f\.r DESC NULLS LAST, COALESCE\(f\.c, 0\) DESC/.test(orderbook),
	'rating ties are broken by how many RATINGS back the average — that is a rating-shaped question, not a trade-shaped one'
);

// ── the proxy must be gone, not half-replaced ───────────────────────
check(
	'the feedback-count-as-trades proxy is documented as retired',
	!/Proxy for "trades completed where this account was a party\."/.test(orderbook),
	'the stale proxy comment still claims feedback_count stands in for trades'
);

console.log('\n' + '─'.repeat(58));
if (fail === 0) {
	console.log(`✓ all ${pass} trade-count-semantics scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
