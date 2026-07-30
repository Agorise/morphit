import { describe, expect, it } from 'vitest';
import type { Database } from '$db/pool';
import type pg from 'pg';

import {
	DEFAULT_WITNESS_FEE_POLLER_CONFIG,
	WitnessFeePoller,
	type WitnessFeeAlert
} from '$indexer/witnessFeePoller';
import { makeMockClient } from '../testutils/mockClient';

/** Build a Database shim whose withTx calls the supplied mock
 *  client once. The blurt argument is unused by ingest(), so we
 *  pass a placeholder. */
function makeFixture(expectations: Parameters<typeof makeMockClient>[0] = []) {
	const mock = makeMockClient(expectations);
	const db: Database = {
		async withTx(fn) {
			return fn(mock.client);
		},
		query: (async () => ({ rows: [], rowCount: 0 })) as unknown as Database['query'],
		async close() {}
	};
	const alerts: WitnessFeeAlert[] = [];
	const poller = new WitnessFeePoller(
		db,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		{} as any, // BlurtClient — ingest() doesn't touch it
		DEFAULT_WITNESS_FEE_POLLER_CONFIG,
		(a) => alerts.push(a)
	);
	return { poller, mock, alerts };
}

describe('WitnessFeePoller.ingest', () => {
	it('writes kind="initial" on the first successful observation', async () => {
		const fx = makeFixture([{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }]);

		await fx.poller.ingest(100, new Date('2026-04-19T12:00:00Z'));

		expect(fx.mock.queries).toHaveLength(1);
		const q = fx.mock.queries[0]!;
		// Third positional param is the observation_kind.
		expect(q.params[2]).toBe('initial');
		// Second param is the fee amount.
		expect(q.params[1]).toBe(100);
		// No alert on the first observation — it's an initial
		// recording, not a change from a prior state.
		expect(fx.alerts).toHaveLength(0);
	});

	it('is idempotent: re-ingesting the same value does NOT write SQL again', async () => {
		// Only one INSERT expectation — the second ingest() should
		// skip the DB entirely.
		const fx = makeFixture([{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }]);

		await fx.poller.ingest(100, new Date('2026-04-19T12:00:00Z'));
		await fx.poller.ingest(100, new Date('2026-04-19T13:00:00Z'));

		expect(fx.mock.queries).toHaveLength(1);
	});

	it('writes kind="change" and fires FEE_CHANGED when value differs', async () => {
		const fx = makeFixture([
			{ match: 'INSERT INTO witness_fee_history', rowCount: 1 },
			{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }
		]);

		await fx.poller.ingest(100, new Date('2026-04-19T12:00:00Z'));
		await fx.poller.ingest(150, new Date('2026-04-19T13:00:00Z'));

		expect(fx.mock.queries).toHaveLength(2);
		expect(fx.mock.queries[1]!.params[2]).toBe('change');
		expect(fx.mock.queries[1]!.params[1]).toBe(150);

		expect(fx.alerts).toHaveLength(1);
		const alert = fx.alerts[0]!;
		expect(alert.kind).toBe('FEE_CHANGED');
		if (alert.kind === 'FEE_CHANGED') {
			expect(alert.oldBlurt).toBe(100);
			expect(alert.newBlurt).toBe(150);
			// Enriched fields (delta + direction + percent) — added
			// in the witness-fee-alerter audit close-out.  Operators
			// with Discord/Matrix bot integrations use these so the
			// bot can pick an emoji based on `direction` and decide
			// urgency from `deltaPct` without reparsing the
			// before/after numbers.
			expect(alert.deltaBlurt).toBe(50);
			expect(alert.deltaPct).toBe(50); // (150-100)/100*100 = 50%
			expect(alert.direction).toBe('up');
		}
	});

	it('updates the cached snapshot after a successful ingest', async () => {
		const fx = makeFixture([{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }]);

		// Before any ingest, the snapshot is the fallback with
		// fromChain=false.
		expect(fx.poller.getCurrentFee().fromChain).toBe(false);
		expect(fx.poller.getCurrentFee().feeBlurt).toBe(
			DEFAULT_WITNESS_FEE_POLLER_CONFIG.fallbackFeeBlurt
		);

		await fx.poller.ingest(150, new Date('2026-04-19T12:00:00Z'));

		const snap = fx.poller.getCurrentFee();
		expect(snap.feeBlurt).toBe(150);
		expect(snap.fromChain).toBe(true);
		expect(snap.observedAt.toISOString()).toBe('2026-04-19T12:00:00.000Z');
	});

	it('records a decrease (fee going DOWN is still a FEE_CHANGED event)', async () => {
		// Symmetry check: the alert fires on any change, not just
		// increases. An operator who sees "fee went from 100 to 50"
		// may want to lower the listing fee too.
		const fx = makeFixture([
			{ match: 'INSERT INTO witness_fee_history', rowCount: 1 },
			{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }
		]);

		await fx.poller.ingest(100, new Date('2026-04-19T12:00:00Z'));
		await fx.poller.ingest(50, new Date('2026-04-19T13:00:00Z'));

		expect(fx.alerts).toHaveLength(1);
		if (fx.alerts[0]!.kind === 'FEE_CHANGED') {
			const a = fx.alerts[0]!;
			expect(a.oldBlurt).toBe(100);
			expect(a.newBlurt).toBe(50);
			expect(a.deltaBlurt).toBe(-50);
			expect(a.deltaPct).toBe(-50); // (50-100)/100*100 = -50%
			expect(a.direction).toBe('down');
		}
	});

	it('is a no-op after the cache is warm with the same value', async () => {
		// Sequentially calling ingest with the same value after the
		// initial write should only ever touch the DB once. Real
		// call sites (maybePoll) throttle to one ingest per hour,
		// so this is the observed pattern.
		const fx = makeFixture([{ match: 'INSERT INTO witness_fee_history', rowCount: 1 }]);

		const t = new Date('2026-04-19T12:00:00Z');
		await fx.poller.ingest(100, t);
		await fx.poller.ingest(100, t);
		await fx.poller.ingest(100, t);

		expect(fx.mock.queries).toHaveLength(1);
	});
});
