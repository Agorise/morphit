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

/** Mirror of the SELECT in src/api/conversations.ts. */
const CONVERSATIONS_SELECT = `
	SELECT
		CASE WHEN sender = $1 THEN recipient ELSE sender END AS peer,
		MAX(created_at) AS last_message_at,
		COUNT(*)::text AS message_count
	FROM chat_messages
	WHERE sender = $1 OR recipient = $1
	GROUP BY peer
	ORDER BY last_message_at DESC
	LIMIT $2
`;

/** Insert one chat_messages row with sensible defaults. Caller
 *  provides sender/recipient/created_at; other fields get fillers
 *  (the endpoint doesn't read them — only the three the query
 *  references). source_trx_id must be unique per insert. */
let trxCounter = 0;
async function insertMessage(
	fx: IntegrationFixture,
	sender: string,
	recipient: string,
	createdAt: Date
): Promise<void> {
	trxCounter += 1;
	await fx.db.query(
		`INSERT INTO chat_messages (
			sender, recipient, ciphertext, header, created_at, source_trx_id
		) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
		[
			sender,
			recipient,
			'ciphertext_placeholder', // endpoint doesn't read this
			{},
			createdAt,
			`trx_${trxCounter}`
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
});
