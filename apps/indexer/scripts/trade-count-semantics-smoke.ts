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
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
	readFileSync(resolve(HERE, '..', rel), 'utf8').replace(/\s+/g, ' ');

const orderbook = read('src/api/orderbook.ts');
const orders = read('src/api/orders.ts');
const join = read('src/api/reputationJoin.ts');

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
	'both endpoints expose trade_count on the wire',
	/trade_count: r\.trade_count/.test(orderbook) && /trade_count: r\.trade_count/.test(orders),
	'the order card reads order.trade_count wherever it renders; an endpoint that omits it silently shows "no trades"'
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
