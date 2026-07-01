/**
 * mcp-server agent-field-allowlist smoke (cp242).
 *
 * The MCP tools surface order data to an AI agent through two trim
 * functions that act as an ALLOWLIST boundary — only known public-
 * facing fields pass; everything else (the indexer's internal fields,
 * and anything added to a response later) is dropped by absence.
 *
 *   - `trimOrderRow`   — used by morphit_search_orders (public /v1/orderbook
 *                        rows, already curated server-side).
 *   - `trimListingRow` — used by morphit_get_listing, which hits the
 *                        OWNER-VIEW `/v1/orders/:account` endpoint. That
 *                        endpoint returns every order regardless of status
 *                        PLUS the lister's internal fee mechanics
 *                        (`fee_status`, `fee_method`). cp242 found
 *                        get_listing returned that row RAW, leaking the
 *                        lister's fee-payment chain / verification state to
 *                        the agent. The fix routes it through
 *                        `trimListingRow`, which keeps `status` + `expires_at`
 *                        (useful for a single-listing view) but drops the fee
 *                        fields and anything else not on the allowlist.
 *
 * This smoke pins both boundaries so a future change can't quietly start
 * leaking internal fields to agents again. It imports the pure functions
 * directly (no dist/main.js spawn).
 */

import { readFileSync } from 'node:fs';
import { trimOrderRow, trimListingRow } from '../src/indexerClient.js';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function check(name: string, passed: boolean, detail?: string): void {
	results.push({ name, passed, detail });
}

/** A representative owner-view row as `/v1/orders/:account` returns it —
 *  public fields + status/expiry + the internal fee mechanics + a stand-in
 *  for "some field added to the endpoint in the future". */
const ownerViewRow: Record<string, unknown> = {
	account: 'alice',
	permlink: 'sell-xmr-usd-1234',
	asset: 'XMR',
	side: 'sell',
	fiat_currency: 'USD',
	price: '150.00',
	amount_min: '0.1',
	amount_max: '5.0',
	location_region: 'EU',
	payment_methods: ['cash', 'sepa'],
	terms: 'in person, Berlin',
	feedback_count: 12,
	weighted_rating: 4.8,
	is_new_trader: false,
	created_at: '2026-05-01T00:00:00Z',
	updated_at: '2026-06-01T00:00:00Z',
	// owner-view-only / internal:
	status: 'live',
	fee_status: 'verified_by_attestation',
	fee_method: 'xmr',
	fee_blurt: '1.250',
	expires_at: '2026-07-01T00:00:00Z',
	__future_internal_field: 'should never reach an agent'
};

const PUBLIC_FIELDS = [
	'account',
	'permlink',
	'asset',
	'side',
	'fiat_currency',
	'price',
	'amount_min',
	'amount_max',
	'location_region',
	'payment_methods',
	'terms',
	'feedback_count',
	'weighted_rating',
	'is_new_trader',
	'created_at',
	'updated_at'
];
const LEAK_FIELDS = ['fee_status', 'fee_method', 'fee_blurt', '__future_internal_field'];

const to = trimOrderRow(ownerViewRow);
const tl = trimListingRow(ownerViewRow);

// trimOrderRow — search results.
check(
	'trimOrderRow keeps all public fields',
	PUBLIC_FIELDS.every((f) => f in to),
	`missing: ${PUBLIC_FIELDS.filter((f) => !(f in to)).join(', ')}`
);
check(
	'trimOrderRow drops fee mechanics + status/expiry + unknown fields',
	[...LEAK_FIELDS, 'status', 'expires_at'].every((f) => !(f in to)),
	`leaked: ${[...LEAK_FIELDS, 'status', 'expires_at'].filter((f) => f in to).join(', ')}`
);

// trimListingRow — single-listing lookup (owner-view endpoint).
check(
	'trimListingRow keeps all public fields',
	PUBLIC_FIELDS.every((f) => f in tl),
	`missing: ${PUBLIC_FIELDS.filter((f) => !(f in tl)).join(', ')}`
);
check(
	'trimListingRow keeps status + expires_at (useful for a single listing)',
	'status' in tl && 'expires_at' in tl,
	`missing: ${['status', 'expires_at'].filter((f) => !(f in tl)).join(', ')}`
);
check(
	'trimListingRow drops fee mechanics + unknown future fields (the cp242 leak fix)',
	LEAK_FIELDS.every((f) => !(f in tl)),
	`leaked: ${LEAK_FIELDS.filter((f) => f in tl).join(', ')}`
);

// Identity sanity — both keep the linkable public identifiers.
check(
	'both trims keep account + permlink',
	to.account === 'alice' && to.permlink === 'sell-xmr-usd-1234' && tl.account === 'alice' && tl.permlink === 'sell-xmr-usd-1234'
);

// Wiring — the tools must actually route their rows through the trims.
// (Function-correctness above is moot if a tool returns the raw row, which
// is exactly the cp242 regression.) Cheap static check on the source.
const getListingSrc = readFileSync(new URL('../src/tools/getListing.ts', import.meta.url), 'utf-8');
const searchOrdersSrc = readFileSync(new URL('../src/tools/searchOrders.ts', import.meta.url), 'utf-8');
check(
	'get_listing routes its row through trimListingRow (not raw)',
	/trimListingRow\s*\(/.test(getListingSrc) && !/listing:\s*match\b/.test(getListingSrc),
	'getListing.ts must call trimListingRow() and must not return `listing: match` raw'
);
check(
	'search_orders routes its rows through trimOrderRow',
	/map\(\s*trimOrderRow\s*\)|trimOrderRow\s*\(/.test(searchOrdersSrc),
	'searchOrders.ts must apply trimOrderRow() (call or .map reference)'
);

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
