import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/order';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';
import type { ChainOperation } from '$blurt/client';

function validPayload() {
	return {
		permlink: 'sell-btc-eur-2026-04',
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'EUR',
		amount_min: 50,
		amount_max: 5000,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['sepa', 'revolut']
	};
}

/** Build a matching fee transfer sibling op. Amount is "N.NNN BLURT"
 *  per Graphene convention. Memo must equal `morphit-fee:<permlink>`. */
function feeTransferOp(
	sender: string,
	amountBlurt: number,
	permlink: string,
	recipient = 'morphit-fees'
): ChainOperation {
	return [
		'transfer',
		{
			from: sender,
			to: recipient,
			amount: `${amountBlurt.toFixed(3)} BLURT`,
			memo: `morphit-fee:${permlink}`
		}
	] as const;
}

describe('order handler', () => {
	it('inserts a valid order', async () => {
		// No siblingOps provided → fee_status='missing'. Path: no
		// Sybil-count probe (skipped when transfer is null), just
		// the INSERT.
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const r = await handler(makeCtx({ signer: 'alice', payload: validPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
	});

	it('accepts optional fields left out', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const p = validPayload();
		// Drop optionals
		const partial: Record<string, unknown> = { ...p };
		delete partial.amount_min;
		delete partial.amount_max;
		const r = await handler(makeCtx({ payload: partial }), mock.client);
		expect(r).toEqual({ ok: true });
	});

	it('rejects bad permlink charset', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({ payload: { ...validPayload(), permlink: 'HAS_CAPS' } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'permlink_bad_chars' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects unknown asset', async () => {
		const mock = makeMockClient();
		// Part 122 cp49 deep-deep A-2: this test previously used
		// 'ETH' as the unknown-asset stand-in.  ETH became a real
		// tradable asset at cp47, silently breaking this test
		// (handler returned ok:true instead of asset_invalid; the
		// vitest unit test path was not part of the standalone
		// smoke battery so the breakage went undetected for 2
		// checkpoints).  Cp49 fixes inline and pins the structural
		// defense in cp49 LL #53 (handler-test-stand-in-meta-
		// assertion-smoke): synthetic non-ticker '__UNKNOWN__'
		// with underscores rejects from the canonical ticker
		// regex which enforces uppercase letters only —
		// mathematically cannot become a real ticker.  Same
		// pattern as cp48-O1's UNKNOWN_STANDIN closure but
		// extended in scope to vitest unit tests.
		const r = await handler(makeCtx({ payload: { ...validPayload(), asset: '__UNKNOWN__' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'asset_invalid' });
	});

	it('rejects unknown side', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({ payload: { ...validPayload(), side: 'short' } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'side_invalid' });
	});

	it('rejects amount_min > amount_max', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), amount_min: 100, amount_max: 50 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'amount_min_exceeds_max' });
	});

	it('rejects negative amount_min', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), amount_min: -1 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'amount_min_negative' });
	});

	it('rejects empty payment_methods', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({ payload: { ...validPayload(), payment_methods: [] } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'payment_methods_bad_count' });
	});

	it('rejects payment_methods with too many entries', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					payment_methods: Array(13).fill('cash')
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'payment_methods_bad_count' });
	});

	it('rejects non-string payment_methods entry', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), payment_methods: [123] }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'payment_method_item_invalid' });
	});

	// Finding L regression: size cap on price_model JSONB payload.
	// The 4KB cap is enforced at intake; this test ensures future
	// refactoring doesn't silently remove it.
	it('rejects price_model exceeding 4KB serialized', async () => {
		const mock = makeMockClient();
		// Build a price_model that serializes to >4KB. A single
		// string field ~4100 chars is over the cap.
		const huge = 'x'.repeat(4100);
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), price_model: { padding: huge } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'price_model_too_large' });
		// Critically: the INSERT must NOT run — if it did, a payload
		// past the cap would hit the DB despite failing validation.
		expect(mock.queries).toHaveLength(0);
	});

	it('accepts price_model right under the 4KB cap', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		// Just under the cap — 3900 chars + wrapping overhead < 4096.
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					price_model: { padding: 'x'.repeat(3900) }
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('accepts a valid ISO expires_at', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), expires_at: '2027-01-01T00:00:00Z' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('rejects unparseable expires_at', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), expires_at: 'not a date' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'expires_at_unparseable' });
	});

	it('rejects oversized terms', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), terms: 'x'.repeat(2049) }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'terms_too_long' });
	});
});

describe('order handler — fee verification', () => {
	it('sets fee_status=missing when no sibling transfer', async () => {
		// Only the INSERT runs (no Sybil count query, since transfer
		// is null). The INSERT's 14th param is the fee_status.
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: validPayload(),
				siblingOps: []
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
		// fee_status is the 15th parameter (1-indexed param[14]); v.expires_at was inserted between blockTime and fee_status of the INSERT.
		expect(mock.queries[0]!.params[14]).toBe('missing');
	});

	it('sets fee_status=verified on exact matching transfer', async () => {
		// Valid tier-1 fee at $0.125 base and $0.002/BLURT = 62.5 BLURT.
		// Sybil count probe returns 0 → nth=1 → expected 62.5.
		const mock = makeMockClient([
			{ match: 'SELECT COUNT', rows: [{ n: '0' }] },
			{ match: 'INSERT INTO orders' }
		]);
		const payload = validPayload();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 62.5, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(2);
		expect(mock.queries[1]!.params[14]).toBe('verified');
	});

	it('accepts a transfer 0.5% below expected (within tolerance)', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT COUNT', rows: [{ n: '0' }] },
			{ match: 'INSERT INTO orders' }
		]);
		const payload = validPayload();
		// 62.5 × 0.995 = 62.188 — within the 1% tolerance band.
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 62.188, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[1]!.params[14]).toBe('verified');
	});

	it('sets fee_status=underpaid when transfer is >1% below expected', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT COUNT', rows: [{ n: '0' }] },
			{ match: 'INSERT INTO orders' }
		]);
		const payload = validPayload();
		// 62.5 × 0.95 = 59.375 — well below the tolerance band.
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 59.375, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[1]!.params[14]).toBe('underpaid');
	});

	it('ignores transfer from a different sender', async () => {
		// Someone else paid a fee for alice's order? We don't treat
		// that as a valid payment — fee must come from the signer.
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const payload = validPayload();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('eve', 62.5, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
		expect(mock.queries[0]!.params[14]).toBe('missing');
	});

	it('ignores transfer with wrong permlink in memo', async () => {
		// Memo doesn't match the order's permlink — not this order's
		// fee payment.
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const payload = validPayload();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 62.5, 'different-permlink')]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[14]).toBe('missing');
	});

	it('ignores transfer to wrong recipient account', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const payload = validPayload();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 62.5, payload.permlink, 'wrong-account')]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[14]).toBe('missing');
	});

	it('uses escalated fee when signer has 3 existing orders', async () => {
		// 3 existing → nth=4 → multiplier 1.25 → expected 78.125 BLURT.
		const mock = makeMockClient([
			{ match: 'SELECT COUNT', rows: [{ n: '3' }] },
			{ match: 'INSERT INTO orders' }
		]);
		const payload = validPayload();
		// Pay the correct escalated amount.
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 78.125, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[1]!.params[14]).toBe('verified');
	});

	it('rejects tier-1 fee when signer is actually at tier 4', async () => {
		// Signer has 3 existing → nth=4 → expected 78.125. If they
		// only pay 62.5 (tier-1 amount), that's a 20% underpayment
		// and should be rejected.
		const mock = makeMockClient([
			{ match: 'SELECT COUNT', rows: [{ n: '3' }] },
			{ match: 'INSERT INTO orders' }
		]);
		const payload = validPayload();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload,
				siblingOps: [feeTransferOp('alice', 62.5, payload.permlink)]
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[1]!.params[14]).toBe('underpaid');
	});
});

describe('order handler — waived_first_buy (ADR-0011)', () => {
	function waivedPayload() {
		// Phase-3 / §F.11 update: the waiver is BLURT-only now.
		// Override the BTC default from validPayload() and set a
		// BLURT-denominated amount_min above the WAIVER_MIN_BLURT
		// floor (500 BLURT).
		return {
			...validPayload(),
			side: 'buy',
			asset: 'BLURT',
			amount_min: 500,
			amount_max: 5000,
			fee_method: 'waived_first_buy'
		};
	}

	it('accepts a valid waived first buy — no prior orders, waiver unclaimed', async () => {
		// Mock SQL sequence:
		//   1. SELECT COUNT(*) FROM orders WHERE account = signer → '0'
		//   2. INSERT INTO accounts ... ON CONFLICT UPDATE ...
		//      RETURNING first_buy_waived_at (rowCount=1, claim won)
		//   3. INSERT INTO orders ...
		const mock = makeMockClient([
			{ match: 'SELECT COUNT(*)', rows: [{ n: '0' }] },
			{
				match: 'INSERT INTO accounts',
				rows: [{ first_buy_waived_at: new Date() }],
				rowCount: 1
			},
			{ match: 'INSERT INTO orders' }
		]);
		const r = await handler(makeCtx({ signer: 'grandma', payload: waivedPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(3);
		// The waived-branch INSERT hardcodes fee_status='verified'
		// as a SQL literal (not a parameter). Verify it's present
		// in the query text rather than looking for a param.
		expect(mock.queries[2]!.text).toContain("'verified'");
	});

	it('rejects waived_first_buy when side is sell', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...waivedPayload(), side: 'sell' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'waiver_requires_buy' });
		// No SQL should have fired — the side check runs before DB
		// access.
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects waived_first_buy when the account has prior orders', async () => {
		// COUNT returns '2' → the waiver is no longer their first.
		const mock = makeMockClient([{ match: 'SELECT COUNT(*)', rows: [{ n: '2' }] }]);
		const r = await handler(makeCtx({ signer: 'bob', payload: waivedPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'waiver_not_first_order' });
		// Only the count query ran; no INSERT attempted.
		expect(mock.queries).toHaveLength(1);
	});

	it('rejects waived_first_buy when the waiver was already claimed', async () => {
		// COUNT returns '0' (no prior orders in index — maybe the
		// account re-registered, or the index was rebuilt), but the
		// UPSERT returns rowCount=0 because first_buy_waived_at is
		// already set. Race / re-use protection.
		const mock = makeMockClient([
			{ match: 'SELECT COUNT(*)', rows: [{ n: '0' }] },
			{ match: 'INSERT INTO accounts', rowCount: 0 }
		]);
		const r = await handler(makeCtx({ signer: 'carol', payload: waivedPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'waiver_already_used' });
		expect(mock.queries).toHaveLength(2);
	});

	it('rejects fee_method=btc when external_tx_id is missing', async () => {
		// Sub-phase 4b: BTC fee payment is now supported but requires
		// `external_tx_id` so the indexer can verify the on-chain BTC
		// payment.  Without it, reject early.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), fee_method: 'btc' }
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'external_tx_id_required_for_btc_xmr'
		});
	});

	it('rejects fee_method=xmr when external_tx_id is missing', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), fee_method: 'xmr' }
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'external_tx_id_required_for_btc_xmr'
		});
	});

	it('Part 108++: rejects fee_method=xmr when tx_proof is missing', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					fee_method: 'xmr',
					external_tx_id: 'a'.repeat(64)
				}
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'tx_proof_required_for_xmr'
		});
	});

	it('Part 108++: rejects fee_method=xmr when tx_proof has wrong prefix', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					fee_method: 'xmr',
					external_tx_id: 'a'.repeat(64),
					tx_proof: 'NotARealProofPrefix' + 'a'.repeat(64)
				}
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'tx_proof_malformed_prefix'
		});
	});

	it('Part 108++: rejects fee_method=xmr when tx_proof is too short', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					fee_method: 'xmr',
					external_tx_id: 'a'.repeat(64),
					tx_proof: 'OutProofV2tooshort'
				}
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'tx_proof_malformed_length'
		});
	});

	it('Part 108++: rejects fee_method=xmr when tx_proof has bad charset', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					fee_method: 'xmr',
					external_tx_id: 'a'.repeat(64),
					tx_proof: 'OutProofV2' + 'a'.repeat(60) + '\nbadchar'
				}
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'tx_proof_malformed_charset'
		});
	});

	it('Part 108++: fee_method=btc does NOT require tx_proof (only XMR does)', async () => {
		// BTC verification path uses the multi-explorer cross-check;
		// it does not need a per-payment proof from the user.  This
		// test confirms the handler's structural validator doesn't
		// accidentally apply the XMR proof requirement to BTC orders.
		// We don't actually configure a BTC verifier in the test
		// harness, so the order will fail at a later check (e.g.
		// `fee_method_not_configured_btc`) — but it must NOT fail
		// with any tx_proof_* reason.  That's the assertion.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					...validPayload(),
					fee_method: 'btc',
					external_tx_id: 'a'.repeat(64)
					// NO tx_proof field — handler should accept this for BTC.
				}
			}),
			mock.client
		);
		// Whatever the rejection reason is, it must NOT be one of the
		// new Part 108++ tx_proof_* validator codes.
		if (!r.ok) {
			expect(r.reason).not.toMatch(/^tx_proof/);
		}
	});

	it('rejects fee_method with an unrecognized value', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), fee_method: 'gold' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_method_unknown' });
	});

	it('rejects fee_method with a non-string value', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { ...validPayload(), fee_method: 42 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_method_not_string' });
	});

	it('accepts omitted fee_method (back-compat with ADR-0009)', async () => {
		// Pre-ADR-0011 orders don't have a fee_method field at all.
		// The handler must treat them as ordinary BLURT-paid orders.
		const mock = makeMockClient([{ match: 'INSERT INTO orders' }]);
		const payload = validPayload(); // no fee_method field
		const r = await handler(makeCtx({ payload }), mock.client);
		expect(r).toEqual({ ok: true });
		// Only the orders INSERT — no accounts UPSERT (not a waiver).
		expect(mock.queries).toHaveLength(1);
	});
});
