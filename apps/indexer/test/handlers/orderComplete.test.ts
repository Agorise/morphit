import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/orderComplete';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

const PERMLINK = 'sell-btc-eur-2026-04';

describe('orderComplete handler (morphit_order_complete_v1)', () => {
	it('flips an owner\'s live order to completed', async () => {
		// UPDATE ... WHERE account=signer AND status='live' matches one row.
		const mock = makeMockClient([
			{ match: "UPDATE orders SET status = 'completed'", rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
		// Owner-only guard: signer is the WHERE account param.
		expect(mock.queries[0]!.params).toContain('alice');
		expect(mock.queries[0]!.params).toContain(PERMLINK);
	});

	it('rejects a NON-owner (griefing guard) with target_not_found', async () => {
		// mallory doesn't own the order: the account=signer UPDATE matches
		// nothing, and the probe (also scoped to mallory) finds nothing.
		const mock = makeMockClient([
			{ match: 'UPDATE orders', rowCount: 0 },
			{ match: 'SELECT status FROM orders', rows: [], rowCount: 0 }
		]);
		const r = await handler(
			makeCtx({ signer: 'mallory', payload: { permlink: PERMLINK } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'target_not_found' });
	});

	it('reports target_already_cancelled when the order is not live', async () => {
		const mock = makeMockClient([
			{ match: 'UPDATE orders', rowCount: 0 },
			{ match: 'SELECT status FROM orders', rows: [{ status: 'cancelled' }], rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'target_already_cancelled' });
	});

	it('is idempotent-safe: a second complete on an already-completed order is a no-op reject', async () => {
		const mock = makeMockClient([
			{ match: 'UPDATE orders', rowCount: 0 },
			{ match: 'SELECT status FROM orders', rows: [{ status: 'completed' }], rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'target_already_completed' });
	});

	// ── v1.5.5 (t155): the optional `counterparty` field ──────────────
	//
	// v1.5.5 credits BOTH sides of a completed trade, which means the owner now
	// NAMES the other party on-chain. That is a public claim about someone else
	// made by a stranger, so every path here is anti-collusion surface.

	it('stores a PROVEN counterparty so both sides get trade credit', async () => {
		const mock = makeMockClient([
			// hasVerifiedChat: 2 each way, 15-min span, pair not flagged.
			{
				match: 'FROM chat_messages',
				rows: [{ from_a: '2', from_b: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: "UPDATE orders SET status = 'completed'", rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK, counterparty: 'bob' } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const update = mock.queries.find((q) => q.text.includes("status = 'completed'"))!;
		expect(update.params).toContain('bob');
	});

	it('rejects naming YOURSELF as the counterparty', async () => {
		// Otherwise one op mints two trade credits for one account.
		const mock = makeMockClient([]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK, counterparty: 'alice' } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'counterparty_is_self' });
		expect(mock.queries).toHaveLength(0); // rejected before touching the DB
	});

	it('rejects a malformed counterparty name without touching the DB', async () => {
		const mock = makeMockClient([]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK, counterparty: 'Not A Name!' } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'counterparty_invalid' });
		expect(mock.queries).toHaveLength(0);
	});

	it('drops an UNPROVEN counterparty but still completes the order', async () => {
		// THE anti-collusion rule: naming someone must clear the same
		// provable-conversation bar a review requires, or anyone could mint fake
		// trade credit for any account — and attach an unconsented public claim
		// to a stranger's name. But the OWNER's own completion is legitimate
		// regardless, so the op must still succeed with counterparty NULL rather
		// than reject: refusing would leave a settled order stuck "Live" in the
		// orderbook, which is the very bug v1.5.5 fixes.
		const mock = makeMockClient([
			// Never chatted → gate denies.
			{
				match: 'FROM chat_messages',
				rows: [{ from_a: '0', from_b: '0', span_seconds: null, has_recip_flag: false }]
			},
			{ match: "UPDATE orders SET status = 'completed'", rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK, counterparty: 'stranger' } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const update = mock.queries.find((q) => q.text.includes("status = 'completed'"))!;
		expect(update.params).not.toContain('stranger');
		expect(update.params).toContain(null);
	});

	it('omitting counterparty stores NULL (older clients stay valid)', async () => {
		// Back-compat: the field is OPTIONAL. A pre-v1.5.5 client broadcasts
		// {permlink} alone and must keep working — the op schema is append-only.
		const mock = makeMockClient([
			{ match: "UPDATE orders SET status = 'completed'", rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: PERMLINK } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// No gate query — nothing to prove.
		expect(mock.queries).toHaveLength(1);
		expect(mock.queries[0]!.params).toContain(null);
	});

	it('rejects a non-object payload', async () => {
		const mock = makeMockClient([]);
		const r = await handler(makeCtx({ signer: 'alice', payload: [] }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects an invalid permlink without touching the DB', async () => {
		const mock = makeMockClient([]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { permlink: 123 } }),
			mock.client
		);
		expect(r.ok).toBe(false);
		expect(mock.queries).toHaveLength(0);
	});
});
