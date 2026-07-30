/**
 * Tool: morphit_search_orders
 *
 * Query the configured Morphit instance's orderbook with filters
 * matching exactly the same surface as the /v1/orderbook HTTP
 * endpoint.  Returns trimmed-down order rows the AI agent can
 * present to the user.
 *
 * Schema mirrors apps/indexer/src/api/orderbook.ts:42-71 (the
 * indexer's Zod schema for the same parameters).  Keeping them in
 * lockstep means the AI agent's tool calls always map cleanly to
 * the underlying API; the instance does the validation and
 * returns clean errors that we surface back to the agent.
 */

import { z } from 'zod';
import { ASSET_TICKERS } from '@morphit/asset-registry';
import { buildV1Url, fetchJson, getInstanceUrl, trimOrderRow } from '../indexerClient.js';

/** AI-agent-facing description.  Kept short and concrete so the
 *  agent's tool-selection step has unambiguous signals about when
 *  to call this.  No marketing language. */
export const SEARCH_ORDERS_DESCRIPTION =
	'Search the live Morphit P2P orderbook for cryptocurrency trades. ' +
	'Returns peer-to-peer offers from real users where one side is a ' +
	'cryptocurrency (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, ' +
	'DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP) and the other side is fiat or ' +
	'a payment-method label representing fiat or barter (cash, bank ' +
	'transfer, Venmo, Cash App, gift cards, in-person meet, etc.). ' +
	'Morphit is non-custodial and KYC-free; the agent never sees keys; ' +
	'this tool only browses listings — the user follows a link to the ' +
	'Morphit web UI to actually execute a trade.';

/** Zod schema for the tool's input.  Each field maps 1:1 to the
 *  /v1/orderbook query parameters, with shapes lifted from the
 *  indexer's own validation. */
export const SearchOrdersInputSchema = z.object({
	asset: z
		.enum(ASSET_TICKERS)
		.optional()
		.describe(
			'Cryptocurrency ticker to filter by. Omit to see all assets. ' +
				'Valid values: BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, ' +
				'DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP.'
		),
	side: z
		.enum(['buy', 'sell'])
		.optional()
		.describe(
			'"buy" means "I want to buy the asset" (so the listing is from ' +
				'someone selling). "sell" is the opposite. Omit for both sides.'
		),
	fiat_currency: z
		.string()
		.regex(/^[A-Z]+$/)
		.min(1)
		.max(8)
		.optional()
		.describe('ISO-4217 currency code, uppercase. e.g. USD, EUR, GBP, JPY.'),
	location_region: z
		.string()
		.min(1)
		.max(128)
		.optional()
		.describe(
			'Region prefix to match against the listing\'s declared region. ' +
				'Free-form because Morphit doesn\'t prescribe a region taxonomy ' +
				'— e.g. "US-CA", "Berlin", "Tokyo". Prefix-matched, case-insensitive.'
		),
	payment_methods: z
		.string()
		.min(1)
		.max(256)
		.optional()
		.describe(
			'Comma-separated list of payment-method slugs from the instance\'s ' +
				'payment-method registry. Matches "any of". e.g. "cash,bank_transfer" ' +
				'matches listings that accept either. To discover valid slugs, ' +
				'call morphit_list_payment_methods first.'
		),
	min_trades: z
		.number()
		.int()
		.nonnegative()
		.max(100)
		.optional()
		.describe(
			'Minimum completed-trade count. New traders (under 4 trades) ' +
				'are flagged is_new_trader=true in results regardless of this ' +
				'filter — use that to highlight risk in the UI.'
		),
	sort: z
		.enum(['recent', 'rating', 'trades'])
		.optional()
		.describe(
			'"recent" (default) = most recently updated first. "rating" = ' +
				'highest weighted feedback first. "trades" = most experienced ' +
				'trader first.'
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Max rows to return. Default 50, max 100.')
});

export type SearchOrdersInput = z.infer<typeof SearchOrdersInputSchema>;

/** Indexer response shape (lifted from /v1/orderbook). */
interface OrderbookResponse {
	rows: Array<Record<string, unknown>>;
	next_cursor?: string | null;
	total?: number;
}

/** Handler.  Takes already-validated input and returns the trimmed
 *  rows plus a deeplink an AI agent can hand the user. */
export async function searchOrders(input: SearchOrdersInput): Promise<{
	rows: Array<Record<string, unknown>>;
	deeplink: string;
	note: string;
}> {
	const url = buildV1Url('/orderbook', {
		asset: input.asset,
		side: input.side,
		fiat_currency: input.fiat_currency,
		location_region: input.location_region,
		payment_methods: input.payment_methods,
		min_trades: input.min_trades,
		sort: input.sort,
		limit: input.limit
	});
	const res = await fetchJson<OrderbookResponse>(url);
	const rows = (res.rows || []).map(trimOrderRow);

	// Build a clickable deeplink so the AI agent can hand the user
	// off to the actual Morphit web UI for the trade step.  Mirror
	// the same filter params in the fragment so the page lands on
	// the filtered orderbook view.
	//
	// cp146 F-mcp-6 — use getInstanceUrl() rather than a direct
	// process.env read so this code path inherits the env-var
	// validation (scheme check, malformed-URL rejection) and we
	// don't have two divergent base-URL derivations.
	const base = getInstanceUrl();
	// cp156 F-mcp-7 — build the inner locale-less path (with the
	// filter query params), then wrap it in `${base}/?then=...`
	// so the root locale-detection shell adds the right locale
	// prefix client-side.  Before cp156 this hardcoded `/en/`,
	// which gave non-English users the English orderbook.
	//
	// Two-step construction:
	//   1. Build the inner URL with searchParams so all values get
	//      proper URI-encoding.
	//   2. Extract `pathname + search` (locale-less) and pass it
	//      to the outer `?then=` via searchParams.set, which
	//      double-encodes the inner `?`/`&` correctly.
	const inner = new URL('/orderbook', base);
	if (input.asset) inner.searchParams.set('asset', input.asset);
	if (input.side) inner.searchParams.set('side', input.side);
	if (input.fiat_currency) inner.searchParams.set('fiat', input.fiat_currency);
	if (input.location_region) inner.searchParams.set('region', input.location_region);
	if (input.payment_methods) inner.searchParams.set('pm', input.payment_methods);
	const ui = new URL('/', base);
	ui.searchParams.set('then', inner.pathname + inner.search);

	return {
		rows,
		deeplink: ui.toString(),
		note:
			'To actually execute a trade, the user must visit the deeplink ' +
			'above in their browser, unlock their Morphit identity (or create ' +
			'one — keys stay on-device, no signup form), and click "Reply" ' +
			'on a listing. Morphit cannot sign trades through this AI tool ' +
			"by design — private keys never leave the user's device."
	};
}
