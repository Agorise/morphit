#!/usr/bin/env tsx
/**
 * reconcile-registrations-smoke (cp710).
 *
 * Proves the operator-registration reconciliation:
 *   1. queries ONLY rejected operator_register ops (never other ops);
 *   2. replays each through the handler and, on success, flips its
 *      `ops` row to 'applied' in the SAME transaction as the
 *      materialisation;
 *   3. leaves a still-genuinely-invalid op rejected (row untouched,
 *      transaction rolled back);
 *   4. is a safe no-op when there's nothing to heal;
 *   5. is bounded (LIMIT + maxRows) and never aborts on one bad row.
 */

import { reconcileOperatorRegistrations, RECONCILE_MAX_ROWS } from '../src/indexer/reconcileRegistrations.ts';
import { OP_IDS } from '../src/indexer/dispatcher.ts';
import type { Handler, OpContext, HandlerResult } from '../src/indexer/handler-contract.ts';
import { unusedBlurt, fakeConfig } from '../test/testutils/context.ts';
import type pg from 'pg';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

interface FakeRow {
	block_num: number;
	trx_in_block: number;
	op_in_trx: number;
	block_time: Date;
	trx_id: string;
	signer: string;
	payload: unknown;
	reject_reason: string | null;
	status: string;
	op_id: string;
}

/** A fake ReconcileDb backed by an in-memory `ops` array.  withTx just
 *  runs the callback against a client whose UPDATE mutates the array;
 *  a throw discards nothing here (we assert on the applied-flip only on
 *  the ok path, and the module only UPDATEs on ok), which faithfully
 *  models "rollback discards the flip". */
function makeFakeDb(rows: FakeRow[]) {
	const selectCalls: Array<{ text: string; params: readonly unknown[] }> = [];
	let committedRollback = 0;
	const db = {
		async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<{ rows: R[] }> {
			selectCalls.push({ text, params: params ?? [] });
			// The reconcile SELECT.
			const opId = (params ?? [])[0];
			const limit = Number((params ?? [])[1]);
			const matched = rows
				.filter((r) => r.op_id === opId && r.status === 'rejected')
				.slice(0, limit) as unknown as R[];
			return { rows: matched };
		},
		async withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
			// Buffer UPDATEs; apply only if the callback resolves (commit),
			// discard if it throws (rollback) — mirrors real withTx.
			const pending: Array<() => void> = [];
			const client = {
				async query(text: string, params?: readonly unknown[]) {
					if (/UPDATE ops SET status = 'applied'/.test(text)) {
						const [bn, ti, oi] = params as [number, number, number];
						pending.push(() => {
							const row = rows.find(
								(r) => r.block_num === bn && r.trx_in_block === ti && r.op_in_trx === oi
							);
							if (row) {
								row.status = 'applied';
								row.reject_reason = null;
							}
						});
					}
					return { rows: [], rowCount: 0 };
				}
			} as unknown as pg.PoolClient;
			try {
				const out = await fn(client);
				for (const p of pending) p(); // commit
				return out;
			} catch (e) {
				committedRollback++; // rollback: discard buffered writes
				throw e;
			}
		}
	};
	return { db, selectCalls, get rollbacks() { return committedRollback; } };
}

function row(over: Partial<FakeRow> = {}): FakeRow {
	return {
		block_num: 1000,
		trx_in_block: 0,
		op_in_trx: 0,
		block_time: new Date('2026-08-01T00:00:00Z'),
		trx_id: 'a'.repeat(40),
		signer: 'alice',
		payload: { v: 1, tag: 'alice', display_name: 'Alice' },
		reject_reason: 'display_name_impersonates_reserved',
		status: 'rejected',
		op_id: OP_IDS.operatorRegister,
		...over
	} as FakeRow;
}

const baseDeps = {
	blurt: unusedBlurt(),
	config: fakeConfig(),
	feeVerifiers: {},
	feeAmounts: {},
	fiatToUsd: (a: number) => (Number.isFinite(a) ? a : null)
} as const;

// Handlers injected for deterministic testing.
const alwaysHeal: Handler = async (): Promise<HandlerResult> => ({ ok: true });
const alwaysReject: Handler = async (): Promise<HandlerResult> => ({ ok: false, reason: 'tag_reserved' });
const throwsOnce = (() => {
	let n = 0;
	const h: Handler = async (): Promise<HandlerResult> => {
		n++;
		if (n === 1) throw new Error('boom');
		return { ok: true };
	};
	return h;
})();

await (async () => {
	// 1. Heals a previously-rejected op → flips to 'applied'.
	{
		const rows = [row({ signer: 'morphit-latino', reject_reason: 'display_name_impersonates_reserved' })];
		const { db } = makeFakeDb(rows);
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db, handler: alwaysHeal });
		ok(s.scanned === 1 && s.healed === 1 && s.stillRejected === 0 && s.errored === 0, 'heals one');
		ok(rows[0]!.status === 'applied' && rows[0]!.reject_reason === null, 'row flipped to applied');
	}

	// 2. Still-invalid op stays rejected (row untouched, tx rolled back).
	{
		const rows = [row({ signer: 'squatter', reject_reason: 'tag_reserved' })];
		const fake = makeFakeDb(rows);
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db: fake.db, handler: alwaysReject });
		ok(s.scanned === 1 && s.healed === 0 && s.stillRejected === 1, 'still-rejected counted');
		ok(rows[0]!.status === 'rejected' && rows[0]!.reject_reason === 'tag_reserved', 'row untouched');
		ok(fake.rollbacks === 1, 'transaction rolled back for still-rejected');
	}

	// 3. Safe no-op when nothing is rejected.
	{
		const rows = [row({ status: 'applied' })];
		const { db } = makeFakeDb(rows);
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db, handler: alwaysHeal });
		ok(s.scanned === 0 && s.healed === 0, 'no-op when nothing rejected');
	}

	// 4. Only operator_register ops are selected (an order op is ignored).
	{
		const rows = [
			row({ signer: 'good', op_id: OP_IDS.operatorRegister }),
			row({ signer: 'orderguy', op_id: OP_IDS.order, reject_reason: 'whatever' })
		];
		const { db, selectCalls } = makeFakeDb(rows);
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db, handler: alwaysHeal });
		ok(s.scanned === 1, 'only operator_register scanned (order op excluded)');
		// The SELECT is parameterised with the operator_register op id.
		ok(selectCalls.some((c) => c.params[0] === OP_IDS.operatorRegister), 'query pins operator_register op id');
		ok(rows.find((r) => r.signer === 'orderguy')!.status === 'rejected', 'order op left untouched');
	}

	// 5. One throwing row is counted as errored; the rest still process.
	{
		const rows = [row({ signer: 'first' }), row({ signer: 'second', trx_in_block: 1 })];
		const { db } = makeFakeDb(rows);
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db, handler: throwsOnce });
		ok(s.scanned === 2 && s.errored === 1 && s.healed === 1, 'one error does not abort the rest');
	}

	// 6. Bounded: default cap is a finite, sane constant; the SELECT
	//    carries a LIMIT param.
	{
		const rows = [row()];
		const { db, selectCalls } = makeFakeDb(rows);
		await reconcileOperatorRegistrations({ ...baseDeps, db, handler: alwaysHeal });
		ok(Number.isFinite(RECONCILE_MAX_ROWS) && RECONCILE_MAX_ROWS > 0, 'RECONCILE_MAX_ROWS is a finite positive cap');
		ok(selectCalls.some((c) => c.params[1] === RECONCILE_MAX_ROWS), 'SELECT applies the row cap');
		// maxRows override is honoured.
		const { db: db2, selectCalls: sc2 } = makeFakeDb([row()]);
		await reconcileOperatorRegistrations({ ...baseDeps, db: db2, handler: alwaysHeal, maxRows: 7 });
		ok(sc2.some((c) => c.params[1] === 7), 'maxRows override honoured');
	}

	// 7. The real handler is idempotent-safe: replaying an
	//    already-registered account returns account_already_registered
	//    (no throw), so reconciliation counts it still-rejected, not
	//    errored — proving the default handler wiring is sane.
	{
		// Use the REAL handler against a client that reports the account
		// already exists.
		const realRows = [row({ signer: 'already', payload: { v: 1, tag: 'already', display_name: 'Already' } })];
		const fake = makeFakeDbRealClient(realRows, { alreadyRegistered: true });
		const s = await reconcileOperatorRegistrations({ ...baseDeps, db: fake.db });
		ok(s.stillRejected === 1 && s.errored === 0, 'already-registered replays as no-op, not an error');
	}
})();

/** Variant fake DB whose withTx client answers the REAL operatorRegister
 *  handler's queries (the SELECT existence check + inserts). */
function makeFakeDbRealClient(rows: FakeRow[], opts: { alreadyRegistered: boolean }) {
	const db = {
		async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
			_text: string,
			params?: readonly unknown[]
		): Promise<{ rows: R[] }> {
			const limit = Number((params ?? [])[1]);
			return { rows: rows.filter((r) => r.status === 'rejected').slice(0, limit) as unknown as R[] };
		},
		async withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
			const client = {
				async query(text: string) {
					if (/SELECT account FROM operators WHERE account/.test(text)) {
						return { rows: opts.alreadyRegistered ? [{ account: 'already' }] : [], rowCount: opts.alreadyRegistered ? 1 : 0 };
					}
					return { rows: [], rowCount: 0 };
				}
			} as unknown as pg.PoolClient;
			return fn(client);
		}
	};
	return { db };
}

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ reconcile-registrations smoke failed');
	process.exit(1);
}
console.log(`✓ all ${passed} reconcile-registrations scenarios pass`);
