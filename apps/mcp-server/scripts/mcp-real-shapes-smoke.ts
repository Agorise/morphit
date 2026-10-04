#!/usr/bin/env tsx
/**
 * mcp-real-shapes-smoke — the MCP tools against what the indexer REALLY sends.
 *
 * Three of the five tools read keys the indexer never sends (`rows`,
 * `display_name`, `declared_region`) and so returned nothing; the search
 * dropped the price, the USDT/USDC/DAI network and the expiry; and `side`
 * was passed straight through although the tool documents it as the USER's
 * intent while the API filters on the LISTER's side — an agent asked "where
 * can I buy XMR" was shown other buyers. The old smoke stubbed hand-written
 * JSON in the wrong shapes, so it passed against a fiction.
 *
 * Here every request the tools make is answered by the REAL indexer route
 * handlers (instances, instance, instance/payment-methods, orderbook,
 * orders/:account), fed by an in-memory database, so the wire shapes cannot
 * drift from the indexer without this failing.
 */

import type { Hono } from 'hono';

// The indexer's own route handlers, loaded at run time (run with the repo's
// tsconfig.smoke.json, which maps the indexer's path aliases). A computed
// specifier keeps the indexer's sources out of this workspace's typecheck.
const INDEXER = new URL('../../indexer/', import.meta.url).href;
type Route = (...args: unknown[]) => Hono;
const route = async (p: string, name: string): Promise<Route> =>
	((await import(`${INDEXER}${p}`)) as Record<string, Route>)[name]!;
const { fakeConfig } = (await import(`${INDEXER}test/testutils/context.ts`)) as {
	fakeConfig: (o?: Record<string, unknown>) => unknown;
};
const instancesRoute = await route('src/api/instances.ts', 'instancesRoute');
const instanceRoute = await route('src/api/instance.ts', 'instanceRoute');
const instancePaymentMethodsRoute = await route(
	'src/api/instancePaymentMethods.ts',
	'instancePaymentMethodsRoute'
);
const orderbookRoute = await route('src/api/orderbook.ts', 'orderbookRoute');
const ordersByAccountRoute = await route('src/api/orders.ts', 'ordersByAccountRoute');

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

const now = new Date('2026-10-01T00:00:00.000Z');
const db = (rows: (sql: string, params: unknown[]) => unknown[]) =>
	({
		query: async (sql: string, params: unknown[] = []) => ({ rows: rows(sql, params) })
	}) as never;

// ─── the indexer, as route handlers over in-memory rows ─────────────────────
const directoryRow = (origin: string, status: string) => ({
	origin,
	operator_account: 'exop',
	operator_tag: 'exop',
	operator_display_name: 'Example Operator',
	cached_name: 'Example Instance',
	cached_tagline: 'tagline',
	cached_contact_url: 'mailto:op@example.org',
	cached_alt_networks: null,
	reg_alt_networks: null,
	last_probe_status: status,
	last_probe_error: null,
	registered_at_time: now,
	last_probed_at: now,
	cached_indexed_block: 100,
	cached_chain_lag_sec: 3,
	cached_clearnet_eliminated: false,
	consecutive_failures: status === 'good' ? 0 : 5
});
const bookRow = {
	account: 'alice',
	permlink: 'sell-usdt-1',
	side: 'sell',
	asset: 'USDT',
	asset_network: 'trc20',
	fiat_currency: 'USD',
	amount_min: '10',
	amount_max: '500',
	price_model: { kind: 'spread', percent: 2 },
	location_region: 'Online',
	payment_methods: ['paypal'],
	accepted_assets: null,
	specific_barter_title: null,
	terms: 'Fast and friendly.',
	lang: 'en',
	fee_method: 'blurt',
	feedback_count: 3,
	trade_count: 5,
	weighted_rating: '4.5',
	last_feedback_at: now,
	is_new_trader: false,
	engagement_24h: 0,
	first_trade_complete_at: now,
	posting_pubkey: null,
	display_name: null,
	profile_json_metadata: null,
	created_at: now,
	updated_at: now,
	expires_at: new Date('2026-10-08T00:00:00.000Z')
};
let orderbookParams: unknown[] = [];
/** 150 orders of one account: the live one sits on the second page. */
const accountOrders = Array.from({ length: 150 }, (_, i) => ({
	...bookRow,
	account: 'bob',
	permlink: `order-${String(i).padStart(3, '0')}`,
	status: i === 120 ? 'live' : 'completed',
	fee_status: 'verified',
	completed_counterparty: null,
	reciprocity_flagged: false,
	updated_at: new Date(now.getTime() - i * 60_000),
	// The route selects updated_at to the microsecond as text for its cursor.
	updated_at_cursor: new Date(now.getTime() - i * 60_000).toISOString().replace('Z', '000Z'),
	btc_fee_index: null,
	btc_fee_address: null,
	btc_fee_xpub: null,
	btc_fee_sats: null,
	btc_fee_received_sats: null,
	btc_fee_unconfirmed_sats: null
}));

const routes: Record<string, Hono> = {
	'/v1/instances': instancesRoute(
		db(() => [
			directoryRow('https://up.example', 'good'),
			directoryRow('https://down.example', 'unreachable')
		])
	),
	'/v1/instance/payment-methods': instancePaymentMethodsRoute(
		db(() => [
			{
				// Stored unprefixed; the route serves it as '@instance:promptpay'.
				key: 'promptpay',
				name: 'PromptPay',
				description: 'Thai instant payments',
				category: 'online',
				url: null
			}
		]),
		fakeConfig()
	),
	'/v1/instance': instanceRoute(
		fakeConfig({
			instanceName: 'Example Instance',
			instanceTagline: 'tagline',
			instanceContactUrl: 'mailto:op@example.org'
		})
	),
	'/v1/orderbook': orderbookRoute(
		db((_sql, params) => {
			orderbookParams = params;
			return [bookRow];
		}),
		{ getStatus: () => ({ indexedBlock: 100 }) } as never,
		'morphit'
	),
	'/v1/orders': ordersByAccountRoute(
		db((sql, params) => {
			// Emulate the route's own keyset page: (updated_at DESC, permlink ASC),
			// cursor params present when the SQL carries the cursor clause.
			const limit = Number(params[params.length - 2]);
			let rows = accountOrders;
			if (sql.includes('o.updated_at < $2')) {
				const u = new Date(params[1] as string | Date).getTime();
				const p = String(params[2]);
				rows = rows.filter(
					(r) => r.updated_at.getTime() < u || (r.updated_at.getTime() === u && r.permlink > p)
				);
			}
			return rows.slice(0, limit);
		}),
		'morphit'
	)
};

let lastUrl = '';
globalThis.fetch = (async (input: string | URL) => {
	const url = new URL(String(input));
	lastUrl = url.toString();
	const prefix = Object.keys(routes)
		.filter((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))
		.sort((a, b) => b.length - a.length)[0];
	if (prefix === undefined) return new Response('not found', { status: 404 });
	const sub = url.pathname.slice(prefix.length) || '/';
	return routes[prefix]!.request(`${sub}${url.search}`);
}) as typeof fetch;

process.env.MORPHIT_MCP_INSTANCE_URL = 'https://morphit.example';
const { searchOrders } = await import('../src/tools/searchOrders.js');
const { listInstances } = await import('../src/tools/listInstances.js');
const { listPaymentMethods } = await import('../src/tools/listPaymentMethods.js');
const { describeMorphit } = await import('../src/tools/describeMorphit.js');
const { getListing } = await import('../src/tools/getListing.js');

console.log('mcp-real-shapes-smoke');

// ─── search ───
const s = await searchOrders({ asset: 'USDT', side: 'buy' });
check(
	'search side "buy" (the user wants to buy) asks for listings that SELL the asset',
	// The route registers the side, then (for barter rows) its opposite.
	new URL(lastUrl).searchParams.get('side') === 'sell' &&
		orderbookParams.indexOf('sell') < orderbookParams.indexOf('buy'),
	`url=${lastUrl} params=${JSON.stringify(orderbookParams)}`
);
const row = s.rows[0] ?? {};
check("search returns the indexer's rows", s.rows.length === 1, `rows=${s.rows.length}`);
check(
	'search keeps price model, network, expiry and trade count',
	'price_model' in row &&
		row['asset_network'] === 'trc20' &&
		'expires_at' in row &&
		row['trade_count'] === 5,
	`keys=${Object.keys(row).join(',')}`
);
check(
	'search marks listing text as untrusted user content',
	(s as { terms_are_untrusted_user_content?: unknown }).terms_are_untrusted_user_content === true
);

// ─── instances ───
const li = await listInstances({});
check(
	'list_instances returns the reachable instances, by name',
	li.instances.length === 1 &&
		li.instances[0]?.['origin'] === 'https://up.example' &&
		li.instances[0]?.['name'] === 'Example Instance',
	JSON.stringify(li.instances)
);
const all = await listInstances({ include_offline: true });
check(
	'list_instances include_offline adds the unreachable one',
	all.instances.length === 2,
	`got ${all.instances.length}`
);

// ─── payment methods ───
const pm = await listPaymentMethods({});
check(
	'list_payment_methods returns the instance additions by their real keys',
	pm.payment_methods.some(
		(m) => m.slug === '@instance:promptpay' && m.display_name === 'PromptPay'
	),
	JSON.stringify(pm)
);

// ─── describe ───
const d = (await describeMorphit({})).morphit as Record<string, unknown>;
check(
	'describe carries the instance name',
	d['instance_display_name'] === 'Example Instance',
	`got ${String(d['instance_display_name'])}`
);

// ─── get listing past the first page ───
let found: unknown = null;
try {
	found = (await getListing({ account: 'bob', permlink: 'order-120' })).listing;
} catch (err) {
	found = `threw: ${(err as Error).message.slice(0, 80)}`;
}
check(
	'get_listing finds a live listing that is not in the newest 100 orders',
	typeof found === 'object' &&
		found !== null &&
		(found as Record<string, unknown>)['permlink'] === 'order-120',
	String(found)
);

console.log();
if (failures > 0) {
	console.error(`✗ ${failures} of ${n} MCP real-shape checks failed`);
	process.exit(1);
}
console.log(`✓ all ${n} MCP real-shape checks passed`);
process.exit(0);
