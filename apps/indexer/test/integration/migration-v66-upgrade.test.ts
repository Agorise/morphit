/**
 * Migration v66 on the UPGRADE path, through the real runMigrations.
 *
 * A fresh install runs schema.sql (which carries the v66 section) and then
 * every numbered migration, so a fresh database proves little about an
 * installed node. Here one database is taken back to the state a v65 node is
 * in — v66's indexes absent, `order_views.updated_at` NOT NULL with a default,
 * v66 not recorded — and filled with the data v66 must repair: duplicate
 * queued dust refills, push subscriptions holding a User-Agent and raw
 * browser languages, view counters holding a last-view time. Then the real
 * runner upgrades it, and the result must equal a fresh install (indexes,
 * columns, constraints, comments), with the data repaired and no drift.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { runMigrations } from '../../src/db/migrations';
import { checkSchemaDrift } from '../../src/db/schemaDrift';

const V66_INDEXES = [
	'chat_messages_sender_idx',
	'chat_messages_recipient_idx',
	'accounts_creator_first_activity_idx',
	'relay_pending_transfers_dust_refill_queued_uidx',
	'profiles_avatar_svg_hash_idx',
	'profiles_avatar_data_uri_hash_idx'
];

/** Everything about the schema that must not depend on the path taken to it. */
async function catalog(fx: IntegrationFixture): Promise<string[]> {
	const res = await fx.db.query<{ line: string }>(
		`SELECT 'IDX ' || replace(indexdef, $1 || '.', '') AS line
		   FROM pg_indexes WHERE schemaname = $1
		 UNION ALL
		 SELECT 'COL ' || table_name || '.' || column_name || ' ' || data_type
		        || ' null=' || is_nullable || ' def=' || coalesce(column_default, '')
		   FROM information_schema.columns WHERE table_schema = $1
		 UNION ALL
		 SELECT 'CON ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
		   FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
		  WHERE k.connamespace = $1::regnamespace
		 UNION ALL
		 SELECT 'CMT ' || c.relname || '.' || coalesce(a.attname, '') || ' ' || d.description
		   FROM pg_description d
		   JOIN pg_class c ON c.oid = d.objoid
		   LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid AND d.objsubid > 0
		  WHERE c.relnamespace = $1::regnamespace
		 ORDER BY 1`,
		[fx.schema]
	);
	// Sequence defaults name the schema; strip it so two schemas compare.
	return res.rows.map((r) =>
		r.line.replaceAll(`"${fx.schema}".`, '').replaceAll(`${fx.schema}.`, '')
	);
}

async function planOf(fx: IntegrationFixture, sql: string): Promise<string> {
	const res = await fx.db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`);
	return res.rows.map((r) => r['QUERY PLAN']).join('\n');
}

describe.skipIf(!INTEGRATION_ENABLED)('migration v66 — upgrade path', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;
	let firstRun: { applied: number[] };
	let secondRun: { applied: number[] };

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		upgraded = await setupWithMigrations();

		// Take `upgraded` back to a v65 node.
		for (const ix of V66_INDEXES) await upgraded.db.query(`DROP INDEX IF EXISTS ${ix}`);
		await upgraded.db.query(`ALTER TABLE order_views ALTER COLUMN updated_at SET DEFAULT now()`);
		await upgraded.db.query(`UPDATE order_views SET updated_at = now()`);
		await upgraded.db.query(`ALTER TABLE order_views ALTER COLUMN updated_at SET NOT NULL`);
		await upgraded.db.query(
			`ALTER TABLE operator_attribution_events
			   ADD CONSTRAINT operator_attribution_events_trx_id_key UNIQUE (trx_id)`
		);
		await upgraded.db.query(
			`ALTER TABLE account_loyalty DROP COLUMN IF EXISTS canonical_blurt_paid`
		);
		await upgraded.db.query(`DELETE FROM schema_migrations WHERE version = 66`);

		// What a v65 node can hold.
		await upgraded.db.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at, broadcast_at) VALUES
			   ('alice', 'liquid', 1, 'dust_refill', now() - interval '2 min', NULL),
			   ('alice', 'liquid', 1, 'dust_refill', now() - interval '1 min', NULL),
			   ('alice', 'liquid', 1, 'dust_refill', now() - interval '30 days', now() - interval '30 days'),
			   ('bob', 'liquid', 1, 'dust_refill', now(), NULL),
			   ('bob', 'liquid', 10, 'welcome_bonus_liquid', now(), NULL),
			   ('bob', 'liquid', 10, 'welcome_bonus_liquid', now(), NULL)`
		);
		await upgraded.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, user_agent, privacy_mode, locale) VALUES
			   ('alice', 'https://push.example/1', 'k', 'a', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', 'standard', 'en-US'),
			   ('alice', 'https://push.example/2', 'k', 'a', NULL, 'standard', 'zh-TW'),
			   ('bob', 'https://push.example/3', 'k', 'a', 'UA', 'standard', 'de'),
			   ('bob', 'https://push.example/4', 'k', 'a', 'UA', 'standard', 'zh-Hans-CN'),
			   ('carol', 'https://push.example/5', 'k', 'a', 'UA', 'standard', 'pt-BR'),
			   ('dave', 'https://push.example/6', 'k', 'a', 'UA', 'standard', 'fa-IR')`
		);
		await upgraded.db.query(`INSERT INTO order_views (permlink, count) VALUES ('alice/o1', 5)`);
		await upgraded.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              cached_clearnet_eliminated)
			 VALUES ('https://claims.example', 'a', 1, now(), TRUE),
			        ($1, 'b', 1, now(), TRUE),
			        ('http://named.i2p', 'c', 1, now(), TRUE),
			        ('https://onion.example.com', 'd', 1, now(), TRUE)`,
			[`http://${'q'.repeat(56)}.onion`]
		);
		await upgraded.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id,
			                       posting_pubkey, posting_key_reconciled)
			 VALUES ('confirmed1', 'c', 1, now(), 't1', 'BLTx', TRUE),
			        ('confirmed2', 'c', 2, now(), 't2', 'BLTy', TRUE),
			        ('unconfirmed', 'c', 3, now(), 't3', 'BLTz', FALSE)`
		);

		await upgraded.db.query(
			`INSERT INTO account_loyalty (account, cumulative_blurt_paid) VALUES ('payer', 50)`
		);

		firstRun = await runMigrations(upgraded.db);
		secondRun = await runMigrations(upgraded.db);
	});

	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('applies v66 once, and a second run applies nothing', () => {
		expect(firstRun.applied).toEqual([66]);
		expect(secondRun.applied).toEqual([]);
	});

	it('the upgraded schema equals a fresh install, and neither has drift', async () => {
		expect(await catalog(upgraded)).toEqual(await catalog(fresh));
		for (const fx of [fresh, upgraded]) {
			const drift = await checkSchemaDrift(fx.db);
			expect(drift.diff).toEqual({ missingTables: [], missingColumns: [], missingIndexes: [] });
		}
	});

	it('keeps one queued dust refill per recipient (the oldest) and leaves other rows alone', async () => {
		const res = await upgraded.db.query<{
			recipient: string;
			reason: string;
			queued: boolean;
			age: string;
		}>(
			`SELECT recipient, reason, broadcast_at IS NULL AS queued,
			        CASE WHEN created_at < now() - interval '90 seconds' THEN 'old' ELSE 'new' END AS age
			   FROM relay_pending_transfers ORDER BY recipient, reason, created_at`
		);
		expect(res.rows).toEqual([
			{ recipient: 'alice', reason: 'dust_refill', queued: false, age: 'old' },
			{ recipient: 'alice', reason: 'dust_refill', queued: true, age: 'old' },
			{ recipient: 'bob', reason: 'dust_refill', queued: true, age: 'new' },
			{ recipient: 'bob', reason: 'welcome_bonus_liquid', queued: true, age: 'new' },
			{ recipient: 'bob', reason: 'welcome_bonus_liquid', queued: true, age: 'new' }
		]);
		// And the database now refuses a second queued refill.
		await expect(
			upgraded.db.query(
				`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at)
				 VALUES ('bob', 'liquid', 1, 'dust_refill', now())`
			)
		).rejects.toThrow(/duplicate key/);
	});

	it('push subscriptions keep no User-Agent and only a supported locale code', async () => {
		const res = await upgraded.db.query<{
			endpoint: string;
			user_agent: string | null;
			locale: string;
		}>(`SELECT endpoint, user_agent, locale FROM push_subscriptions ORDER BY endpoint`);
		expect(res.rows.map((r) => r.user_agent)).toEqual([null, null, null, null, null, null]);
		expect(res.rows.map((r) => r.locale)).toEqual(['en', 'zh-HK', 'de', 'zh-CN', 'en', 'fa']);
	});

	it('a zero-clearnet badge stays only on instances registered at a hidden origin', async () => {
		const res = await upgraded.db.query<{ origin: string; cached_clearnet_eliminated: boolean }>(
			`SELECT origin, cached_clearnet_eliminated FROM known_instances ORDER BY origin`
		);
		expect(res.rows).toEqual([
			{ origin: 'http://named.i2p', cached_clearnet_eliminated: true },
			{ origin: `http://${'q'.repeat(56)}.onion`, cached_clearnet_eliminated: true },
			{ origin: 'https://claims.example', cached_clearnet_eliminated: false },
			{ origin: 'https://onion.example.com', cached_clearnet_eliminated: false }
		]);
	});

	it('every confirmed posting key goes back to unconfirmed', async () => {
		const res = await upgraded.db.query(
			`SELECT count(*)::int AS n FROM accounts WHERE posting_key_reconciled`
		);
		expect(res.rows[0]).toEqual({ n: 0 });
	});

	it('two attributed orders in one transaction both keep their earnings row', async () => {
		await upgraded.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block) VALUES ('op', 'op', 'op', 1)`
		);
		for (const p of ['o1', 'o2']) {
			await upgraded.db.query(
				`INSERT INTO operator_attribution_events
				   (operator_account, operator_tag, order_account, order_permlink, fee_blurt,
				    operator_share_blurt, treasury_share_blurt, split_percent_at_event,
				    trx_id, block_num, block_time_at)
				 VALUES ('op', 'op', 'alice', $1, 10, 9, 1, 90, 'same-trx', 5, now())`,
				[p]
			);
		}
		await expect(
			upgraded.db.query(
				`INSERT INTO operator_attribution_events
				   (operator_account, operator_tag, order_account, order_permlink, fee_blurt,
				    operator_share_blurt, treasury_share_blurt, split_percent_at_event,
				    trx_id, block_num, block_time_at)
				 VALUES ('op', 'op', 'alice', 'o1', 10, 9, 1, 90, 'replay', 6, now())`
			)
		).rejects.toThrow(/duplicate key/);
	});

	it('order_views keeps the count and no view time, on upgrade and on later views', async () => {
		const before = await upgraded.db.query(`SELECT count, updated_at FROM order_views`);
		expect(before.rows).toEqual([{ count: '5', updated_at: null }]);
		await upgraded.db.query(`INSERT INTO order_views (permlink, count) VALUES ('bob/o2', 1)`);
		const after = await upgraded.db.query(
			`SELECT updated_at FROM order_views WHERE permlink = 'bob/o2'`
		);
		expect(after.rows).toEqual([{ updated_at: null }]);
	});

	it('the per-chat-message lookups, Signal A and the avatar check use an index at volume', async () => {
		await upgraded.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 SELECT 'u' || (i % 500), 'u' || ((i * 7) % 500), 'c', '{}', now() - (i || ' s')::interval, 't' || i
			   FROM generate_series(1, 20000) i`
		);
		await upgraded.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, first_activity_at)
			 SELECT 'a' || i, 'c' || (i % 50), i, now(), 'r' || i, now() - (i || ' s')::interval
			   FROM generate_series(1, 20000) i`
		);
		await upgraded.db.query(
			`INSERT INTO profiles (account, display_name, json_metadata, source_block_num, source_trx_id, updated_at)
			 SELECT 'p' || i, 'P', jsonb_build_object('avatar_svg', md5(i::text)), 1, 'x' || i, now()
			   FROM generate_series(1, 5000) i`
		);
		await upgraded.db.query('ANALYZE chat_messages');
		await upgraded.db.query('ANALYZE accounts');
		await upgraded.db.query('ANALYZE profiles');

		const pair = await planOf(
			upgraded,
			`SELECT 1 FROM chat_messages WHERE (sender = 'u1' AND recipient = 'u7') OR (sender = 'u7' AND recipient = 'u1')`
		);
		const fanIn = await planOf(
			upgraded,
			`SELECT sender FROM chat_messages WHERE recipient = 'u1' AND created_at > now() - interval '24 hours'`
		);
		const inbox = await planOf(
			upgraded,
			`SELECT 1 FROM chat_messages WHERE sender = 'u1' OR recipient = 'u1'`
		);
		const signalA = await planOf(
			upgraded,
			`SELECT 1 FROM accounts a JOIN accounts b ON a.creator = b.creator AND a.name < b.name
			  WHERE a.first_activity_at IS NOT NULL AND b.first_activity_at IS NOT NULL
			    AND b.first_activity_at BETWEEN a.first_activity_at - interval '300 s'
			                               AND a.first_activity_at + interval '300 s'`
		);
		const avatar = await planOf(
			upgraded,
			`SELECT 1 FROM profiles WHERE account <> 'p1' AND json_metadata->>'avatar_svg' = 'abc' LIMIT 1`
		);
		for (const p of [pair, fanIn, inbox]) expect(p).not.toMatch(/Seq Scan on chat_messages/);
		expect(pair).toMatch(/chat_messages_sender_idx/);
		expect(fanIn).toMatch(/chat_messages_recipient_idx/);
		expect(signalA).toMatch(/accounts_creator_first_activity_idx/);
		expect(avatar).toMatch(/profiles_avatar_svg_hash_idx/);
	});

	it('an avatar too large for a B-tree entry is still accepted', async () => {
		const big = Array.from(
			{ length: 500 },
			(_, i) => `${i}${Math.random().toString(36).slice(2)}`
		).join('');
		await upgraded.db.query(
			`INSERT INTO profiles (account, display_name, json_metadata, source_block_num, source_trx_id, updated_at)
			 VALUES ('bigavatar', 'B', jsonb_build_object('avatar_svg', $1::text), 1, 'big', now())`,
			[big]
		);
	});

	it('account_loyalty gains canonical_blurt_paid, starting at zero for existing rows', async () => {
		const r = await upgraded.db.query<{ c: string }>(
			`SELECT canonical_blurt_paid::text AS c FROM account_loyalty WHERE account = 'payer'`
		);
		expect(r.rows[0]!.c).toBe('0');
		await expect(
			upgraded.db.query(
				`UPDATE account_loyalty SET canonical_blurt_paid = -1 WHERE account = 'payer'`
			)
		).rejects.toThrow();
	});
});
