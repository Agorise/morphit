/**
 * The boot-time foreign-code heal holds every payout the relay has not sent:
 * error_count past the relay's retry limit, and a reason in last_error.
 *
 * WHAT WAS WRONG. It wrote the reason over EVERY unsent row's last_error,
 * including a row whose last_error is the relay's record of a signed payment
 * that may already be on chain ('in_flight trx_id=…' or 'outcome_unknown
 * trx_id=…'). The transaction id was gone, `morphit-ops failed-broadcasts`
 * showed the row as plainly "not sent" instead of "may have been sent", and
 * re-queuing it, as the hold asks the operator to do for genuine payouts,
 * could pay it twice.
 *
 * NOW: such a row is held with its record kept (the operator's list shows it
 * as "may have been sent", with the lookup); every other unsent row gets the
 * reason. Real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	HELD_ERROR_COUNT,
	HELD_REASON,
	healForeignDatabaseCode
} from '../../src/indexer/foreignCodeHeal';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const TX = 'ab'.repeat(20);

describe.skipIf(!INTEGRATION_ENABLED)('the foreign-code heal keeps a payment record', () => {
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

	async function queue(reason: string, lastError: string | null, sent = false): Promise<void> {
		await fx.db.query(
			`INSERT INTO relay_pending_transfers
			   (recipient, kind, amount_blurt, reason, created_at, last_error, broadcast_at)
			 VALUES ('alice', 'liquid', 10, $1, NOW(), $2, $3)`,
			[reason, lastError, sent ? new Date() : null]
		);
	}
	async function rows(): Promise<
		Record<string, { last_error: string | null; error_count: number }>
	> {
		const r = await fx.db.query<{ reason: string; last_error: string | null; error_count: number }>(
			`SELECT reason, last_error, error_count FROM relay_pending_transfers`
		);
		return Object.fromEntries(
			r.rows.map((x) => [x.reason, { last_error: x.last_error, error_count: x.error_count }])
		);
	}

	it('holds every unsent payout, and keeps the record of one that may be on chain', async () => {
		const signed = `in_flight trx_id=${TX} exp=1700000000000`;
		const unknown = `outcome_unknown trx_id=${TX} exp=1700000000000 checks=2 cause=timeout`;
		await queue('fresh', null);
		await queue('claimed', 'in_flight');
		await queue('signed', signed);
		await queue('unknown', unknown);
		await queue('done', null, true);
		// Database code Morphit never creates.
		await fx.db.query(
			`CREATE FUNCTION morphit_foreign_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`
		);

		const out = await healForeignDatabaseCode(fx.db);
		expect(out.dropped.length).toBeGreaterThan(0);
		expect(out.held).toBe(4);

		const r = await rows();
		// Nothing was signed for these: the reason replaces what was there.
		expect(r.fresh).toEqual({ last_error: HELD_REASON, error_count: HELD_ERROR_COUNT });
		expect(r.claimed).toEqual({ last_error: HELD_REASON, error_count: HELD_ERROR_COUNT });
		// A signed payment that may be on chain keeps its record.
		expect(r.signed).toEqual({ last_error: signed, error_count: HELD_ERROR_COUNT });
		expect(r.unknown).toEqual({ last_error: unknown, error_count: HELD_ERROR_COUNT });
		// A sent payout is not touched.
		expect(r.done).toEqual({ last_error: null, error_count: 0 });
	});
});
