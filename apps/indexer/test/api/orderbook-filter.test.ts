/**
 * v1.8.15 (cp555) — orderbook Filter: "test all 8 fields" (t.txt #4).
 *
 * THE BUGS THIS GUARDS AGAINST (Ken, on live morphit.io):
 *   - Location was a PREFIX match (`region%`), so searching "mzt" could not
 *     find an order whose location is "Mazatlán Mazatlan MZT México Mexico"
 *     (that string starts with "Maz", not "mzt"). Now a case-insensitive
 *     SUBSTRING match.
 *   - The Asset filter matched only the TRADED asset (o.asset), so selecting
 *     "Tether" / "Monero" found nothing when the crypto was used to PAY
 *     (payment_methods `pay_usdt` / `pay_xmr`) rather than being the traded
 *     asset. Now the Asset filter surfaces every order INVOLVING the crypto:
 *     traded asset OR pay_<ticker> payment OR barter-accepted (accepted_assets).
 *
 * buildWhereClauses is the single filter chokepoint shared by the REST
 * `/v1/orderbook` endpoint and the SSE stream (snapshot, live emit, fallback
 * poll), so pinning it here covers every field on the form: side, asset,
 * fiat_currency, location_region, payment_methods, min_trades. (Sort and the
 * free-text "order details" search are handled elsewhere — sort in the query
 * ORDER BY, order-details client-side over terms.)
 */

import { describe, expect, it } from 'vitest';
import { buildWhereClauses } from '$api/orderbookStreamHelpers';

/** The AND-joined WHERE text for the given filter (operatorAccount omitted). */
function clausesFor(q: Parameters<typeof buildWhereClauses>[0]): {
	sql: string;
	params: unknown[];
} {
	const { where, params } = buildWhereClauses(q, 0, '');
	return { sql: where.join(' AND '), params };
}

describe('buildWhereClauses — orderbook filter fields', () => {
	it('base predicates always present (live, fee-verified, unexpired)', () => {
		const { sql } = clausesFor({});
		expect(sql).toContain("o.status = 'live'");
		expect(sql).toContain("o.fee_status IN ('verified', 'verified_by_attestation')");
		expect(sql).toContain('o.expires_at IS NULL OR o.expires_at > NOW()');
	});

	it('asset: matches traded asset OR pay_<ticker> payment OR accepted_assets', () => {
		const { sql, params } = clausesFor({ asset: 'USDT' });
		// Traded asset.
		expect(sql).toContain('o.asset =');
		// Crypto payment method (canonical pay_usdt key), case-insensitively.
		expect(sql).toContain('unnest(o.payment_methods) pm WHERE lower(pm) =');
		// Barter-accepted set.
		expect(sql).toContain('= ANY(o.accepted_assets)');
		// The three legs are OR-ed into a single grouped clause.
		expect(sql).toMatch(/\(o\.asset = \$\d+ OR EXISTS .* OR \$\d+ = ANY\(o\.accepted_assets\)\)/);
		// Params: the uppercase ticker and the lowercase pay_ key.
		expect(params).toContain('USDT');
		expect(params).toContain('pay_usdt');
	});

	it('asset: pay_ key is derived lowercase from the ticker (XMR → pay_xmr)', () => {
		const { params } = clausesFor({ asset: 'XMR' });
		expect(params).toContain('XMR');
		expect(params).toContain('pay_xmr');
	});

	it('side: exact match', () => {
		const { sql } = clausesFor({ side: 'buy' });
		expect(sql).toContain('o.side =');
	});

	it('fiat_currency: uppercased, matches any of the codes', () => {
		const { sql, params } = clausesFor({ fiat_currency: 'mxn,usd' });
		expect(sql).toContain('o.fiat_currency = ANY(');
		expect(params).toContainEqual(['MXN', 'USD']);
	});

	it('location_region: case-insensitive SUBSTRING match, not prefix', () => {
		const { sql, params } = clausesFor({ location_region: 'mzt' });
		expect(sql).toContain('o.location_region ILIKE');
		// The param must be wrapped %...% (contains), so "mzt" finds "...MZT...".
		const likeParam = params.find((v) => typeof v === 'string' && v.includes('mzt'));
		expect(likeParam).toBe('%mzt%');
		// Regression: must NOT be a bare prefix pattern.
		expect(likeParam).not.toBe('mzt%');
	});

	it('location_region: LIKE metacharacters stay literal (escaped)', () => {
		const { params } = clausesFor({ location_region: '100%' });
		// "%" is escaped inside, still wrapped for contains.
		const likeParam = params.find(
			(v): v is string => typeof v === 'string' && v.startsWith('%100')
		);
		expect(likeParam).toBeDefined();
		expect(likeParam).toContain('\\%');
		expect(likeParam!.startsWith('%')).toBe(true);
		expect(likeParam!.endsWith('%')).toBe(true);
	});

	it('payment_methods: EXISTS over unnest, lowercased tokens', () => {
		const { sql, params } = clausesFor({ payment_methods: 'PayPal,barter_goods' });
		expect(sql).toContain('EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = ANY(');
		expect(params).toContainEqual(['paypal', 'barter_goods']);
	});

	it('min_trades: filters real completed-trade count', () => {
		const { sql, params } = clausesFor({ min_trades: 5 });
		expect(sql).toContain('COALESCE(tc.c, 0) >=');
		expect(params).toContain(5);
	});

	it('all fields together compose without collision', () => {
		const { sql } = clausesFor({
			asset: 'BTC',
			side: 'sell',
			fiat_currency: 'eur',
			location_region: 'berlin',
			payment_methods: 'sepa',
			min_trades: 20
		});
		// Every field contributes its predicate.
		expect(sql).toContain('o.asset =');
		expect(sql).toContain('o.side =');
		expect(sql).toContain('o.fiat_currency = ANY(');
		expect(sql).toContain('o.location_region ILIKE');
		expect(sql).toContain('unnest(o.payment_methods)');
		expect(sql).toContain('COALESCE(tc.c, 0) >=');
	});
});
