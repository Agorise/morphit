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
