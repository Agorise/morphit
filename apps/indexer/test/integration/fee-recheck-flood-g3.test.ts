/**
 * (wave 4) — a steady or bursty flood of fake BTC/XMR
 * orders must not starve a real payer's fee re-check.
 *
 * Mirrors the verifier's harness (scratchpad V2/g3-flood.ts) against the REAL
 * schema (all migrations) and the real ExternalFeeRechecker:
 *   - a real order lands pending; the explorers confirm it on its 2nd check;
 *   - every 10-minute pass a spammer posts FLOOD fresh fake orders (each a
 *     `missing` row — a quorum of explorers said "no such tx"), or one burst
 *     of 2000 right after the real order.
 * The wave-3 in-memory rotation still starved the real order: fresh fakes are
 * "never checked" and always sorted first, and a 2000 burst pushed the real
 * order out of the newest-2000 candidate window. The re-check now keeps the
 * last-checked time IN THE ROW (orders.fee_rechecked_at, migration v63),
 * selects least-recently-checked in SQL, gives each account a bounded share
 * per pass, and caps how many `missing` rows compete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ExternalFeeRechecker } from '../../src/indexer/fee/externalFeeRecheck';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const T0 = Date.parse('2026-09-27T12:00:00Z');
const PASS_MS = 10 * 60 * 1000 + 1;

describe.skipIf(!INTEGRATION_ENABLED)('G3 — re-check survives a fake-order flood', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	async function insertOrders(
		account: string,
		permlinks: readonly string[],
		at: number,
		feeStatus: string
	): Promise<void> {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
			                     payment_methods, status, created_at, updated_at,
			                     fee_status, fee_method, external_tx_id)
			 SELECT $1, p, 'sell', 'BTC', 'USD', '{"kind":"spread","percent":0}'::jsonb,
			        ARRAY['cash'], 'live', $2, $2, $3, 'btc', md5(p) || md5(p || 'x')
			   FROM unnest($4::text[]) AS p`,
			[account, new Date(at), feeStatus, permlinks]
		);
	}

	async function run(opts: { flood?: number; burst?: number }): Promise<{
		checks: number;
		confirmed: boolean;
	}> {
		let clock = T0;
		await insertOrders('realpayer', ['real-order'], clock, 'pending_external');
		let checks = 0;
		let confirmed = false;
		const verifier: FeeVerifier = {
			name: 'stub',
			verify: async (c) => {
				if (c.permlink !== 'real-order') {
					return { kind: 'rejected', reason: 'tx_not_found: 2 explorer(s) answered 404' };
				}
				checks++;
				return checks >= 2
					? { kind: 'verified', observedAmount: 416 }
					: { kind: 'pending_external', reason: 'not yet confirmed' };
			}
		};
		const rc = new ExternalFeeRechecker(
			fx.db,
			() => ({ verifiers: { btc: verifier }, amounts: { btcSatoshis: 416 } }),
			(id) => {
				if (id === 'realpayer/real-order') confirmed = true;
			},
			() => clock
		);
		let fakes = 0;
		for (let pass = 0; pass < 72; pass++) {
			const n =
				opts.burst !== undefined ? (pass === 1 ? opts.burst : 0) : pass > 0 ? (opts.flood ?? 0) : 0;
			if (n > 0) {
				const perms = Array.from({ length: n }, () => `fake-${fakes++}`);
				await insertOrders('spammer', perms, clock - 1000, 'missing');
			}
			// maybeRun only starts the pass (it runs in the background); wait for it.
			await rc.maybeRun();
			await rc.whenIdle();
			clock += PASS_MS;
		}
		return { checks, confirmed };
	}

	it('a steady flood of 25 fakes per pass does not stop the real order confirming', async () => {
		const r = await run({ flood: 25 });
		expect(r.confirmed).toBe(true);
	}, 60_000);

	it('a single burst of 2000 fakes does not push the real order out', async () => {
		const r = await run({ burst: 2000 });
		expect(r.confirmed).toBe(true);
	}, 60_000);

	it('the last-checked time is persisted in the row (survives a restart)', async () => {
		await run({ flood: 0 });
		const r = await fx.db.query<{ fee_rechecked_at: Date | null }>(
			`SELECT fee_rechecked_at FROM orders WHERE permlink = 'real-order'`
		);
		expect(r.rows[0]?.fee_rechecked_at).toBeInstanceOf(Date);
	}, 60_000);
});
