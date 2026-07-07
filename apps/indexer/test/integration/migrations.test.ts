/**
 * Integration test — migrations apply cleanly.
 *
 * Smoke test: if this fails, every other integration test
 * cascades into meaningless noise. Keep the assertions light;
 * if migrations grow richer (check constraints, triggers,
 * materialised views), this test grows with them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setup, type IntegrationFixture } from './harness';

// If integration is disabled, we still register a describe so the
// skip is visible in the test output (rather than the suite just
// vanishing).
describe.skipIf(!INTEGRATION_ENABLED)('migrations — integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setup();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	it('applies v1 → v3 without SQL errors', async () => {
		// applyMigrations runs each SQL file in order. It'll throw
		// on any error, which vitest turns into a failure.
		await fx.applyMigrations();
	});

	it('creates every expected table', async () => {
		// information_schema.tables, scoped to our test schema.
		const res = await fx.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = $1
			 ORDER BY table_name`,
			[fx.schema]
		);
		const names = res.rows.map((r) => r.table_name);
		expect(names).toEqual(
			expect.arrayContaining([
				'accounts',
				'chat_messages',
				'fee_transfers',
				'feedback',
				'feedback_responses',
				'indexer_state',
				'ops',
				'orders',
				'profiles',
				'related_accounts',
				'relay_pending_transfers',
				'releases',
				'schema_migrations',
				'suspicious_reciprocity',
				'witness_fee_history'
			])
		);
	});

	it('orders has the fee_status column added in v2', async () => {
		const res = await fx.db.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'orders' AND column_name = 'fee_status'`,
			[fx.schema]
		);
		expect(res.rowCount).toBe(1);
		expect(res.rows[0]!.data_type).toBe('text');
	});

	it('fee_status CHECK constraint rejects invalid values', async () => {
		// Insert a minimal valid order first.
		await fx.db.query(
			`INSERT INTO orders (
				account, permlink, side, asset, fiat_currency,
				price_model, payment_methods, status,
				created_at, updated_at
			) VALUES ('alice', 'sell-btc-usd-aaa', 'sell', 'BTC', 'USD',
			          '{}'::jsonb, ARRAY['cash'], 'live',
			          NOW(), NOW())`
		);
		// Now try to update its fee_status to something invalid.
		await expect(
			fx.db.query(`UPDATE orders SET fee_status = 'bogus' WHERE permlink = 'sell-btc-usd-aaa'`)
		).rejects.toThrow();
	});

	it('related_accounts enforces canonical a < b ordering', async () => {
		await expect(
			fx.db.query(
				`INSERT INTO related_accounts (account_a, account_b, reason)
				 VALUES ('zulu', 'alpha', 'test')` // b < a — violates CHECK
			)
		).rejects.toThrow();
	});

	// ─── v4 additions ────────────────────────────────────────
	it('accounts has the first_buy_waived_at column added in v4', async () => {
		const res = await fx.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'accounts'
			   AND column_name IN ('first_buy_waived_at', 'first_trade_complete_at')
			 ORDER BY column_name`,
			[fx.schema]
		);
		expect(res.rows.map((r) => r.column_name)).toEqual([
			'first_buy_waived_at',
			'first_trade_complete_at'
		]);
	});

	it('relay_pending_transfers kind CHECK rejects invalid values', async () => {
		// Valid kinds: 'liquid', 'vesting'. Anything else rejects.
		await expect(
			fx.db.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at)
				 VALUES ('alice', 'erroneous', 10, 'test', NOW())`
			)
		).rejects.toThrow();
	});

	it('relay_pending_transfers amount_blurt CHECK rejects negative', async () => {
		// v4 originally enforced amount_blurt > 0; schema-v6 relaxed
		// this to amount_blurt >= 0 so delegation rows can use a zero
		// sentinel (kind='delegation' uses the bp column instead).
		// Negative values are still rejected.
		await expect(
			fx.db.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at)
				 VALUES ('alice', 'liquid', -5, 'test', NOW())`
			)
		).rejects.toThrow();
	});

	it('witness_fee_history observation_kind CHECK is enforced', async () => {
		// Valid values: 'initial', 'change'. 'rebase' is not.
		await expect(
			fx.db.query(
				`INSERT INTO witness_fee_history
				   (observed_at, account_creation_fee_blurt, observation_kind)
				 VALUES (NOW(), 100, 'rebase')`
			)
		).rejects.toThrow();
	});

	it('witness_fee_history account_creation_fee_blurt CHECK rejects negative', async () => {
		// The chain should never report a negative fee, but the
		// DB defends against it regardless.
		await expect(
			fx.db.query(
				`INSERT INTO witness_fee_history
				   (observed_at, account_creation_fee_blurt, observation_kind)
				 VALUES (NOW(), -1, 'initial')`
			)
		).rejects.toThrow();
	});

	// ─── Collapse regression (May 2026 audit) ────────────────
	// The migration runner was collapsed from 27 incremental files
	// (schema.sql + schema-v2.sql ... schema-v27.sql) into a single
	// canonical schema.sql.  The runner records all 27 versions in
	// schema_migrations on a fresh DB so any downstream "is v15
	// applied?" check still returns true.  These tests lock that
	// behavior in.

	it('records all 27 historical versions in schema_migrations on a fresh DB', async () => {
		const res = await fx.db.query<{ version: number }>(
			`SELECT version FROM schema_migrations
			 WHERE version BETWEEN 1 AND 27
			 ORDER BY version`
		);
		const versions = res.rows.map((r) => r.version);
		expect(versions).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
			27
		]);
	});

	it('subsumed versions (v2-v27) have descriptions referencing v1', async () => {
		// The runner records subsumed versions with a description
		// like "subsumed by v1 (collapsed canonical schema ...)".
		// This makes it obvious in operator dashboards that v2-v27
		// weren't separately applied — they're part of v1.
		const res = await fx.db.query<{
			version: number;
			description: string;
		}>(
			`SELECT version, description FROM schema_migrations
			 WHERE version BETWEEN 2 AND 27
			 ORDER BY version
			 LIMIT 1`
		);
		expect(res.rowCount).toBe(1);
		expect(res.rows[0]!.description).toContain('subsumed by v1');
	});

	it('every v1-v27 table from the historical migrations exists', async () => {
		// The collapsed schema must produce a superset of tables
		// from every individual historical migration.  Spot-check
		// every distinct table introduced anywhere in v1-v27.
		const expectedTables = [
			// v1
			'orders',
			'feedback',
			'feedback_responses',
			'profiles',
			'related_accounts',
			'suspicious_reciprocity',
			'releases',
			'ops',
			'indexer_state',
			'schema_migrations',
			// v2
			'fee_transfers',
			// v3
			'accounts',
			// v4
			'relay_pending_transfers',
			'witness_fee_history',
			// v5
			'fee_attestations',
			// v6
			'account_loyalty',
			'account_loyalty_milestones',
			// v7
			'operators',
			'operator_earnings',
			'operator_registration_events',
			// v8
			'chat_messages',
			// v9
			'featured_slot_bids',
			// v13
			'chat_identities',
			// v14
			'chat_read_state',
			// v15
			'blocks',
			// v16
			'stranger_fees',
			// v21
			'known_instances',
			// v22
			'order_views',
			// v23
			'operator_blocks',
			// v24
			'instance_payment_methods',
			// v27
			'operator_attribution_events'
			// NOTE: `operator_payouts` was introduced at v27 but RETIRED at
			// cp408 (a v28+ change) — see schema.sql "operator_payouts:
			// RETIRED (cp408)". The runner applies the consolidated schema.sql
			// (current state), which correctly omits the table, so it must NOT
			// appear in this expected-superset. (No live code references it;
			// the collapsed baseline is authoritative.)
		];
		const res = await fx.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = $1
			 ORDER BY table_name`,
			[fx.schema]
		);
		const actual = new Set(res.rows.map((r) => r.table_name));
		const missing = expectedTables.filter((t) => !actual.has(t));
		expect(missing).toEqual([]);
	});
});
