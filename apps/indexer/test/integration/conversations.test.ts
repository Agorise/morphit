/**
 * Integration test — /v1/conversations endpoint SQL.
 *
 * Exercises the GROUP BY + CASE expression the conversations
 * endpoint uses to collapse bidirectional message flows into a
 * single "peer" row per counterparty.
 *
 * Mirrors the SQL in src/api/conversations.ts. The most important
 * property being tested: the CASE expression must fold messages
 * from alice→bob AND bob→alice into the same "peer=bob" group
 * when the query account is alice. Get that wrong and the user
 * sees two entries for every conversation — once as peer when
 * they replied, once as sender when they initiated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

/** Mirror of the SELECT in src/api/conversations.ts. Kept in sync
 *  so the test exercises the real query shape (incl. the order
 *  LATERAL + orders join added for the "RE: <order>" subline). */
const CONVERSATIONS_SELECT = `
	SELECT
		g.peer,
		g.last_message_at,
		g.message_count,
		g.has_user_sent,
		o.permlink          AS order_permlink,
		o.account           AS order_account,
		o.side              AS order_side,
		o.asset             AS order_asset,
		o.fiat_currency     AS order_fiat_currency,
		o.amount_min::text  AS order_amount_min,
		o.amount_max::text  AS order_amount_max
	FROM (
		SELECT
			CASE WHEN sender = $1 THEN recipient ELSE sender END AS peer,
			MAX(created_at) AS last_message_at,
			COUNT(*)::text AS message_count,
			BOOL_OR(sender = $1) AS has_user_sent
		FROM chat_messages
		WHERE sender = $1 OR recipient = $1
		GROUP BY peer
		ORDER BY last_message_at DESC
		LIMIT $2
	) g
	LEFT JOIN LATERAL (
		SELECT m.order_permlink, m.recipient AS order_owner
		FROM chat_messages m
		WHERE m.order_permlink IS NOT NULL
			AND (
				(m.sender = $1 AND m.recipient = g.peer)
				OR (m.sender = g.peer AND m.recipient = $1)
			)
		ORDER BY m.created_at DESC
		LIMIT 1
	) lm ON TRUE
	LEFT JOIN orders o
		ON o.account = lm.order_owner
		AND o.permlink = lm.order_permlink
	ORDER BY g.last_message_at DESC
`;

/** Insert one chat_messages row with sensible defaults. Caller
 *  provides sender/recipient/created_at; other fields get fillers
 *  (the endpoint doesn't read them — only the columns the query
 *  references). source_trx_id must be unique per insert.
 *
 *  `orderPermlink` (optional) sets the plaintext order_permlink
 *  column (migration 25) — the recipient is the order owner, per
 *  chat.ts's validator. */
let trxCounter = 0;
async function insertMessage(
	fx: IntegrationFixture,
	sender: string,
	recipient: string,
	createdAt: Date,
	orderPermlink: string | null = null
): Promise<void> {
	trxCounter += 1;
	await fx.db.query(
		`INSERT INTO chat_messages (
			sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink
		) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
		[
			sender,
			recipient,
			'ciphertext_placeholder', // endpoint doesn't read this
			{},
			createdAt,
			`trx_${trxCounter}`,
			orderPermlink
		]
	);
}

/** Insert an order row (the "RE:" join target). Only the columns
 *  the conversations query reads matter to the assertions; the rest
 *  are filled to satisfy NOT-NULL constraints (price_model jsonb,
 *  payment_methods text[], created_at/updated_at). */
async function insertOrder(
	fx: IntegrationFixture,
	account: string,
	permlink: string,
	opts: {
		side?: 'buy' | 'sell';
		asset?: string;
		fiat?: string;
		amountMin?: number | null;
		amountMax?: number | null;
		status?: 'live' | 'cancelled' | 'expired';
	} = {}
): Promise<void> {
	await fx.db.query(
		`INSERT INTO orders (
			account, permlink, side, asset, fiat_currency, amount_min, amount_max,
			price_model, payment_methods, status, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10, $10)`,
		[
			account,
			permlink,
			opts.side ?? 'buy',
			opts.asset ?? 'BLURT',
			opts.fiat ?? 'MXN',
			opts.amountMin ?? null,
			opts.amountMax ?? null,
			[], // payment_methods text[]
			opts.status ?? 'live',
			new Date('2026-04-01T00:00:00Z')
		]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('conversations endpoint — SQL integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	beforeEach(async () => {
		await truncateAll(fx);
		trxCounter = 0;
	});

	it('returns empty list for an account with no chat history', async () => {
		const result = await fx.db.query(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(0);
	});

	it('collapses bidirectional messages with the same peer into one row', async () => {
		// alice ↔ bob: three messages, mixed direction. Should
		// render as ONE row with peer=bob when alice queries.
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'));
		await insertMessage(fx, 'bob', 'alice', new Date('2026-04-23T11:00:00Z'));
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T12:00:00Z'));

		const result = await fx.db.query<{
			peer: string;
			last_message_at: Date;
			message_count: string;
		}>(CONVERSATIONS_SELECT, ['alice', 200]);

		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.peer).toBe('bob');
		expect(result.rows[0]!.message_count).toBe('3');
		// last_message_at is the MAX of the three.
		expect(result.rows[0]!.last_message_at.toISOString()).toBe('2026-04-23T12:00:00.000Z');
	});

	it('lists multiple peers, sorted newest-first by last message', async () => {
		// alice's history: bob (oldest last msg), carol (middle),
		// dave (newest). Expect order dave > carol > bob.
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-20T10:00:00Z'));
		await insertMessage(fx, 'alice', 'carol', new Date('2026-04-22T10:00:00Z'));
		await insertMessage(fx, 'dave', 'alice', new Date('2026-04-23T10:00:00Z'));

		const result = await fx.db.query<{ peer: string }>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(3);
		expect(result.rows.map((r) => r.peer)).toEqual(['dave', 'carol', 'bob']);
	});

	it('excludes conversations the account is not part of', async () => {
		// bob ↔ carol, eve ↔ dave — alice is in neither.
		await insertMessage(fx, 'bob', 'carol', new Date('2026-04-23T10:00:00Z'));
		await insertMessage(fx, 'eve', 'dave', new Date('2026-04-23T11:00:00Z'));
		// alice ↔ fred — the only one that should show for alice.
		await insertMessage(fx, 'alice', 'fred', new Date('2026-04-23T12:00:00Z'));

		const result = await fx.db.query<{ peer: string }>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.peer).toBe('fred');
	});

	it('message_count aggregates correctly per peer', async () => {
		// 5 msgs with bob, 2 with carol, 1 with dave.
		for (let i = 0; i < 5; i += 1) {
			await insertMessage(
				fx,
				i % 2 === 0 ? 'alice' : 'bob',
				i % 2 === 0 ? 'bob' : 'alice',
				new Date(`2026-04-23T10:${String(i).padStart(2, '0')}:00Z`)
			);
		}
		await insertMessage(fx, 'alice', 'carol', new Date('2026-04-22T10:00:00Z'));
		await insertMessage(fx, 'carol', 'alice', new Date('2026-04-22T11:00:00Z'));
		await insertMessage(fx, 'dave', 'alice', new Date('2026-04-21T10:00:00Z'));

		const result = await fx.db.query<{
			peer: string;
			message_count: string;
		}>(CONVERSATIONS_SELECT, ['alice', 200]);

		expect(result.rowCount).toBe(3);
		const byPeer = Object.fromEntries(result.rows.map((r) => [r.peer, r.message_count]));
		expect(byPeer.bob).toBe('5');
		expect(byPeer.carol).toBe('2');
		expect(byPeer.dave).toBe('1');
	});

	it('LIMIT clips to the requested number of rows', async () => {
		// Insert 5 distinct peers; request LIMIT 3.
		const peers = ['bob', 'carol', 'dave', 'eve', 'frank'];
		for (let i = 0; i < peers.length; i += 1) {
			await insertMessage(fx, 'alice', peers[i]!, new Date(`2026-04-${20 + i}T10:00:00Z`));
		}
		const result = await fx.db.query<{ peer: string }>(CONVERSATIONS_SELECT, ['alice', 3]);
		expect(result.rowCount).toBe(3);
		// Newest-first: frank, eve, dave (highest 3 created_ats).
		expect(result.rows.map((r) => r.peer)).toEqual(['frank', 'eve', 'dave']);
	});

	it('returns correct peer when account is the SENDER', async () => {
		// alice sent to bob. From alice's perspective, peer=bob.
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'));
		const result = await fx.db.query<{ peer: string }>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.peer).toBe('bob');
	});

	it('returns correct peer when account is the RECIPIENT', async () => {
		// bob sent to alice. From alice's perspective, peer=bob.
		await insertMessage(fx, 'bob', 'alice', new Date('2026-04-23T10:00:00Z'));
		const result = await fx.db.query<{ peer: string }>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.peer).toBe('bob');
	});

	// ─── "RE: <order>" subline (order LATERAL + orders join) ──────────

	type OrderRow = {
		peer: string;
		order_permlink: string | null;
		order_account: string | null;
		order_side: string | null;
		order_asset: string | null;
		order_fiat_currency: string | null;
		order_amount_min: string | null;
		order_amount_max: string | null;
	};

	it('order fields are all NULL when the conversation references no order', async () => {
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'));
		await insertMessage(fx, 'bob', 'alice', new Date('2026-04-23T11:00:00Z'));
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		const r = result.rows[0]!;
		expect(r.order_permlink).toBeNull();
		expect(r.order_account).toBeNull();
		expect(r.order_asset).toBeNull();
	});

	it('surfaces the order when alice cites BOB\u2019s order (order_account = bob)', async () => {
		// bob owns the order; alice messages bob citing it → the
		// message recipient (bob) is the order owner.
		await insertOrder(fx, 'bob', 'order-abc', {
			side: 'buy',
			asset: 'BLURT',
			fiat: 'MXN',
			amountMin: 500,
			amountMax: null
		});
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'), 'order-abc');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		const r = result.rows[0]!;
		expect(r.order_permlink).toBe('order-abc');
		expect(r.order_account).toBe('bob');
		expect(r.order_side).toBe('buy');
		expect(r.order_asset).toBe('BLURT');
		expect(r.order_fiat_currency).toBe('MXN');
		expect(r.order_amount_min).toBe('500'); // NUMERIC::text → frontend Number()
		expect(r.order_amount_max).toBeNull();
	});

	it('surfaces the order when BOB cites ALICE\u2019s order (order_account = alice, the recipient)', async () => {
		// alice owns the order; bob messages alice citing it → the
		// recipient (alice) is the owner. RE: works in both directions.
		await insertOrder(fx, 'alice', 'order-mine', { side: 'sell', asset: 'BTC', fiat: 'USD' });
		await insertMessage(fx, 'bob', 'alice', new Date('2026-04-23T10:00:00Z'), 'order-mine');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		const r = result.rows[0]!;
		expect(r.order_permlink).toBe('order-mine');
		expect(r.order_account).toBe('alice');
		expect(r.order_side).toBe('sell');
		expect(r.order_asset).toBe('BTC');
	});

	it('picks the MOST RECENT order-carrying message when several orders were discussed', async () => {
		await insertOrder(fx, 'bob', 'order-old', { asset: 'BLURT' });
		await insertOrder(fx, 'bob', 'order-new', { asset: 'LTC' });
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'), 'order-old');
		await insertMessage(fx, 'bob', 'alice', new Date('2026-04-23T11:00:00Z')); // no order, newer
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T12:00:00Z'), 'order-new');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		// Most recent message WITH an order_permlink is order-new.
		expect(result.rows[0]!.order_permlink).toBe('order-new');
		expect(result.rows[0]!.order_asset).toBe('LTC');
	});

	it('still surfaces a CANCELLED order (rows persist; RE: link stays useful)', async () => {
		await insertOrder(fx, 'bob', 'order-dead', { status: 'cancelled', asset: 'XMR' });
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'), 'order-dead');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rows[0]!.order_permlink).toBe('order-dead');
		expect(result.rows[0]!.order_asset).toBe('XMR');
	});

	it('yields NULL order fields when the cited order row is absent (join miss)', async () => {
		// A message cites a permlink but no matching orders row exists
		// (should not happen — the validator requires it — but the
		// LEFT JOIN must degrade to null, not error or leak a partial).
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'), 'order-ghost');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.order_permlink).toBeNull();
		expect(result.rows[0]!.order_account).toBeNull();
	});

	it('returns a min/max range order intact', async () => {
		await insertOrder(fx, 'bob', 'order-range', {
			side: 'buy',
			asset: 'BLURT',
			fiat: 'EUR',
			amountMin: 100,
			amountMax: 250
		});
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-23T10:00:00Z'), 'order-range');
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		const r = result.rows[0]!;
		expect(r.order_amount_min).toBe('100');
		expect(r.order_amount_max).toBe('250');
		expect(r.order_fiat_currency).toBe('EUR');
	});

	it('attaches orders per-conversation, not across peers', async () => {
		// alice ↔ bob cites bob's order; alice ↔ carol cites nothing.
		await insertOrder(fx, 'bob', 'order-bob', { asset: 'BLURT' });
		await insertMessage(fx, 'alice', 'bob', new Date('2026-04-22T10:00:00Z'), 'order-bob');
		await insertMessage(fx, 'alice', 'carol', new Date('2026-04-23T10:00:00Z')); // newer, no order
		const result = await fx.db.query<OrderRow>(CONVERSATIONS_SELECT, ['alice', 200]);
		expect(result.rowCount).toBe(2);
		const byPeer = Object.fromEntries(result.rows.map((r) => [r.peer, r.order_permlink]));
		expect(byPeer.bob).toBe('order-bob');
		expect(byPeer.carol).toBeNull();
	});
});
