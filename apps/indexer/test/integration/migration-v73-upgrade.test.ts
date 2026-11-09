/**
 * Repeat trades (schema v73): a node UPGRADED to v73 ends up with exactly the
 * columns and comments a FRESH install has, and what it works out for the
 * history it already holds when it starts — counterparty_named_at (from the
 * applied completion ops), order_account and review_weight — equals what the
 * live handlers record.
 *
 * The same trades are applied through the real completion and review handlers
 * on a fresh database (recording each applied completion op as the poller
 * does), then their rows — without the new columns — are copied into a
 * database at v72, which then upgrades and runs the start-up steps. Every
 * review must end with the same values on both, and the same proof.
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import feedbackHandler from '../../src/indexer/handlers/feedback';
import orderCompleteHandler from '../../src/indexer/handlers/orderComplete';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	healNamingTimes,
	healOrderAccounts,
	provenTradeSql,
	rewalkAllPairs
} from '../../src/indexer/reputation/repeatTrades';
import { countedFeedbackFrom, reviewWeightSql } from '../../src/api/reputationJoin';
import { makeCtx } from '../testutils/context';

const H = 3_600_000;
const D = 24 * H;
// Between the consensus v2 and v1.23.5 activation times: what an upgrade
// works out is the history from before v1.23.5 (a node an older version ran
// past the v1.23.5 activation time does not start: repeatTradesGuard.ts), and
// BLURT orders posted before v2 prove no trade (pinnableOrderSql).
const T = Date.parse('2026-11-03T12:00:00Z');
const at = (days: number, hours = 0) => new Date(T + days * D + hours * H);

async function shape(fx: IntegrationFixture): Promise<Record<string, unknown>> {
	const q = async (sql: string): Promise<unknown[]> => (await fx.pool.query(sql, [fx.schema])).rows;
	return {
		columns:
			await q(`SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
			       col_description(format('%I.%I', c.table_schema, c.table_name)::regclass,
			                       c.ordinal_position::int) AS comment
			  FROM information_schema.columns c
			 WHERE c.table_schema = $1
			   AND ((c.table_name = 'feedback' AND c.column_name IN ('order_account', 'review_weight'))
			     OR (c.table_name = 'orders' AND c.column_name = 'counterparty_named_at')
			     OR (c.table_name = 'indexer_state'
			         AND c.column_name IN ('repeat_trades_through_block', 'review_signals_redo_due')))
			 ORDER BY 1, 2`)
	};
}

type Marks = Record<string, [string | null, number | null, boolean]>;
async function marks(fx: IntegrationFixture): Promise<Marks> {
	const r = await fx.db.query<{
		reviewer: string;
		order_permlink: string;
		order_account: string | null;
		review_weight: number | null;
		proven: boolean;
	}>(
		`SELECT f.reviewer, f.order_permlink, f.order_account, f.review_weight,
		        ${provenTradeSql('f')} AS proven
		   FROM feedback f
		  ORDER BY f.reviewer, f.order_permlink`
	);
	return Object.fromEntries(
		r.rows.map((x) => [
			`${x.reviewer}:${x.order_permlink}`,
			[x.order_account, x.review_weight === null ? null : Number(x.review_weight), x.proven]
		])
	);
}
async function namedAt(fx: IntegrationFixture): Promise<Record<string, string | null>> {
	const r = await fx.db.query<{ k: string; at: Date | null }>(
		`SELECT account || '/' || permlink AS k, counterparty_named_at AS at FROM orders ORDER BY 1`
	);
	return Object.fromEntries(r.rows.map((x) => [x.k, x.at === null ? null : x.at.toISOString()]));
}

describe.skipIf(!INTEGRATION_ENABLED)('repeat trades: upgraded = fresh (v73)', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;
	let trx = 0;
	let block = 0;
	let unwalked: { pairs: number; counted: number; correlated: number; worked: number };
	async function weights(fx: IntegrationFixture) {
		const q = async (sql: string) => Number((await fx.db.query<{ n: string }>(sql)).rows[0]!.n);
		return {
			pairs: await q(`SELECT COUNT(DISTINCT (reviewer, subject))::text AS n
			                  FROM feedback WHERE order_permlink IS NOT NULL`),
			counted: await q(`SELECT COUNT(*)::text AS n FROM ${countedFeedbackFrom()}`),
			correlated: await q(`SELECT COUNT(*) FILTER (WHERE ${reviewWeightSql('f')} > 0)::text AS n
			                       FROM feedback f WHERE f.order_permlink IS NOT NULL`),
			worked: await q(`SELECT COUNT(*)::text AS n FROM feedback WHERE review_weight IS NOT NULL`)
		};
	}

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		upgraded = await setupWithMigrations();
		const s = `"${upgraded.schema}"`;
		for (const col of ['order_account', 'review_weight'])
			await upgraded.pool.query(`ALTER TABLE ${s}.feedback DROP COLUMN ${col}`);
		await upgraded.pool.query(`ALTER TABLE ${s}.orders DROP COLUMN counterparty_named_at`);
		for (const col of ['repeat_trades_through_block', 'review_signals_redo_due'])
			await upgraded.pool.query(`ALTER TABLE ${s}.indexer_state DROP COLUMN ${col}`);
		await upgraded.pool.query(`DELETE FROM ${s}.schema_migrations WHERE version = 73`);

		// The trades, live, on the fresh database.
		const db = fresh.db;
		const op = (signer: string, when: Date, payload: Record<string, unknown>) =>
			makeCtx({ signer, blockTime: when, payload, trxId: String(++trx).padStart(40, '0') });
		const chat = async (a: string, b: string, when: Date) => {
			for (let i = 0; i < 4; i++) {
				const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
				await db.query(
					`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
					 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4)`,
					[from, to, new Date(when.getTime() + i * 10 * 60_000), `c-${a}-${b}-${i}`]
				);
			}
		};
		const tag = (from: string, to: string, permlink: string, when: Date) =>
			db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4, $5)`,
				[from, to, when, `tag-${permlink}-${from}`, permlink]
			);
		const order = (owner: string, permlink: string, when: Date, fee = 'blurt') =>
			db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ($1, $2, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         'live', $3, $3, 'verified', $4)`,
				[owner, permlink, when, fee]
			);
		// A completion, recorded in `ops` as the poller records an applied op.
		const complete = async (
			owner: string,
			permlink: string,
			partner: string | null,
			when: Date
		) => {
			const payload = partner === null ? { permlink } : { permlink, counterparty: partner };
			const r = await db.withTx((c) => orderCompleteHandler(op(owner, when, payload), c));
			await db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, 0, 0, $2, $3, $4, 'morphit_order_complete_v1', $5::jsonb, $6)`,
				[
					++block,
					when,
					`op-${block}`,
					owner,
					JSON.stringify(payload),
					r.ok ? 'applied' : 'rejected'
				]
			);
			return r;
		};
		const review = (reviewer: string, subject: string, permlink: string, when: Date, rating = 5) =>
			db.withTx((c) =>
				feedbackHandler(op(reviewer, when, { subject, rating, order_permlink: permlink }), c)
			);
		await chat('alice', 'bob', at(-1));
		await chat('alice', 'carol', at(-1));
		// alice and bob: days 0, 1, 2, 4, 5, 8 — spaced: 0, 4, 8.
		for (const [i, d] of [0, 1, 2, 4, 5, 8].entries()) {
			await order('alice', `ab${i}`, at(d, -1));
			expect(await complete('alice', `ab${i}`, 'bob', at(d))).toEqual({ ok: true });
			expect(await review('bob', 'alice', `ab${i}`, at(d, 1))).toEqual({ ok: true });
			// The last one: alice never reviews back (not proven).
			// 3★: under the review gate before v1.23.5 three 5★ each way in a
			// week would stop the fourth trade.
			if (i < 5) expect(await review('alice', 'bob', `ab${i}`, at(d, 2), 3)).toEqual({ ok: true });
		}
		// carol: reviews first, completion naming her after (proven then).
		await order('carol', 'c1', at(3, -1));
		await tag('alice', 'carol', 'c1', at(3, -0.5));
		expect(await review('alice', 'carol', 'c1', at(3))).toEqual({ ok: true });
		expect(await review('carol', 'alice', 'c1', at(3, 1))).toEqual({ ok: true });
		expect(await complete('carol', 'c1', 'alice', at(3, 2))).toEqual({ ok: true });
		// dave: auto-completed naming nobody, both reviewed, the partner named a
		// day later (G7) — proven from then.
		await chat('alice', 'dave', at(-1));
		await order('alice', 'd1', at(9, -1));
		expect(await complete('alice', 'd1', null, at(9))).toEqual({ ok: true });
		await tag('dave', 'alice', 'd1', at(9, 0.5));
		expect(await review('dave', 'alice', 'd1', at(9, 1))).toEqual({ ok: true });
		expect(await review('alice', 'dave', 'd1', at(9, 2))).toEqual({ ok: true });
		expect(await complete('alice', 'd1', 'dave', at(10))).toEqual({ ok: true });
		// wes and xan: xan has a paid order under the permlink they never traded
		// on (not tagged, not completed naming wes), wes's first-buy waiver order
		// is the one they traded on (completed naming xan, xan sent the BLURT).
		// Admission takes the waiver order; a "paid first" back-fill would not.
		await chat('wes', 'xan', at(11));
		await order('xan', 'w1', at(11, 1));
		await order('wes', 'w1', at(11, 2), 'waived_first_buy');
		expect(await complete('wes', 'w1', 'xan', at(12))).toEqual({ ok: true });
		await db.query(
			`INSERT INTO waiver_trade_transfers (recipient, sender, block_num, trx_in_block, op_in_trx, block_time, trx_id, amount_blurt)
			 VALUES ('wes', 'xan', 99, 0, 0, $1, 'xfer', 500)`,
			[at(12, 1)]
		);
		expect(await review('xan', 'wes', 'w1', at(12, 2))).toEqual({ ok: true });
		// yul and zed both own a paid order under y1, which they discussed.
		// yul reviews zed first; only later does yul complete his own order
		// naming zed. At the review, zed's order was the one that admitted it
		// (the subject's), and a later completion does not change that.
		await chat('yul', 'zed', at(13));
		await order('yul', 'y1', at(13, 1));
		await order('zed', 'y1', at(13, 1));
		await tag('zed', 'yul', 'y1', at(13, 2));
		expect(await review('yul', 'zed', 'y1', at(13, 3))).toEqual({ ok: true });
		expect(await complete('yul', 'y1', 'zed', at(14))).toEqual({ ok: true });

		// mia and nox: nox's order (a BTC fee) is the one they traded on, mia
		// owns a BLURT-fee order under the same permlink. The review is recorded
		// against mia's: a fee each node verifies when it gets to it never is.
		await chat('mia', 'nox', at(15));
		await order('nox', 'n1', at(15, 1), 'btc');
		await order('mia', 'n1', at(15, 1));
		await tag('nox', 'mia', 'n1', at(15, 2));
		expect(await complete('nox', 'n1', 'mia', at(15, 3))).toEqual({ ok: true });
		expect(await review('mia', 'nox', 'n1', at(15, 4))).toEqual({ ok: true });

		// The same history, without the v73 columns, on the node at v72.
		const copy = async (table: string, cols: string) => {
			const rows = (await fresh.db.query(`SELECT ${cols} FROM ${table} ORDER BY 1`)).rows;
			for (const r of rows) {
				const keys = Object.keys(r);
				await upgraded.db.query(
					`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
					keys.map((k) => (r as Record<string, unknown>)[k])
				);
			}
		};
		await copy(
			'orders',
			`account, permlink, side, asset, fiat_currency, price_model, payment_methods, status,
			 created_at, updated_at, fee_status, fee_method, completed_at, completed_counterparty`
		);
		await copy(
			'feedback',
			`id, reviewer, subject, rating, comment, order_permlink, created_at, source_trx_id, has_verified_chat`
		);
		await copy(
			'chat_messages',
			'source_trx_id, sender, recipient, ciphertext, header, created_at, order_permlink'
		);
		await copy(
			'waiver_trade_transfers',
			'recipient, sender, block_num, trx_in_block, op_in_trx, block_time, trx_id, amount_blurt'
		);
		await copy(
			'ops',
			'block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status'
		);
		const { runMigrations } = await import('../../src/db/migrations');
		const r = await runMigrations(upgraded.db);
		expect(r.applied).toEqual([73]);
		unwalked = await weights(upgraded);
		// What the indexer does at every start.
		expect(await healNamingTimes(upgraded.db)).toBeGreaterThan(0);
		expect(await healOrderAccounts(upgraded.db)).toBeGreaterThan(0);
		expect(await rewalkAllPairs(upgraded.db)).toBeGreaterThan(0);
		expect(await healNamingTimes(upgraded.db)).toBe(0);
		expect(await healOrderAccounts(upgraded.db)).toBe(0);
		expect(await rewalkAllPairs(upgraded.db)).toBe(0);
	}, 120_000);

	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('the same columns, defaults and comments', async () => {
		const a = await shape(fresh);
		expect((a.columns as unknown[]).length).toBe(5);
		expect(await shape(upgraded)).toEqual(a);
	});

	it('what start-up works out is what the live handlers recorded, review by review', async () => {
		const live = await marks(fresh);
		expect(Object.keys(live).length).toBe(18);
		// bob's proven days 0 and 4 count half; 1, 2 and 5 are within 72 hours
		// of the last spaced one; day 8 (his latest) counts fully, unproven.
		expect(['ab0', 'ab1', 'ab2', 'ab3', 'ab4', 'ab5'].map((p) => live[`bob:${p}`]![1])).toEqual([
			0.5, 0, 0, 0.5, 0, 1
		]);
		expect(live['bob:ab5']![2]).toBe(false);
		expect(live['carol:c1']).toEqual(['carol', 1, true]);
		expect(live['alice:c1']).toEqual(['carol', 1, true]);
		expect(live['dave:d1']).toEqual(['alice', 1, true]);
		expect(live['alice:d1']).toEqual(['alice', 1, true]);
		expect(live['xan:w1']).toEqual(['wes', 1, false]);
		expect(live['yul:y1']).toEqual(['zed', 1, false]);
		expect(live['mia:n1']).toEqual(['mia', 1, false]);
		expect(await marks(upgraded)).toEqual(live);
	});

	it('when each partner was named: from the applied completion ops', async () => {
		const live = await namedAt(fresh);
		expect(live['alice/d1']).toBe(at(10).toISOString());
		expect(live['alice/ab0']).toBe(at(0).toISOString());
		expect(await namedAt(upgraded)).toEqual(live);
	});

	it('before the start-up steps, only the latest review of each pair counts (as in v1.23.4)', async () => {
		expect(unwalked.worked).toBe(0);
		expect(unwalked.pairs).toBeGreaterThan(0);
		expect(unwalked.counted).toBe(unwalked.pairs);
		expect(unwalked.correlated).toBe(unwalked.pairs);
		// After them, the repeat trades count too, as on the fresh node.
		const after = await weights(upgraded);
		expect(after.counted).toBeGreaterThan(after.pairs);
		expect(after.correlated).toBe(after.counted);
		expect(after).toEqual(await weights(fresh));
	});

	it('run again (a restore over a database that has the columns), it changes nothing', async () => {
		const before = [await marks(upgraded), await namedAt(upgraded)];
		await upgraded.db.query(`DELETE FROM schema_migrations WHERE version = 73`);
		const { runMigrations } = await import('../../src/db/migrations');
		expect((await runMigrations(upgraded.db)).applied).toEqual([73]);
		expect([await marks(upgraded), await namedAt(upgraded)]).toEqual(before);
	});
});
