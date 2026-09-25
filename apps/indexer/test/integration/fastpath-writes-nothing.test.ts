/**
 * ADR-0048 invariant #1, against a REAL database: the fast path never writes.
 *
 * WHY THIS IS THE ONE WORTH RUNNING ON POSTGRES. Everything about the
 * federation fast path being safe rests on a single claim — a pushed chat
 * message is displayed, never persisted. It is what makes it acceptable that a
 * push is accepted from a peer over a hidden transport, verified on a worker,
 * and emitted before the chain has seen it: if the fast path cannot write, the
 * worst a forged or replayed push can do is show something that a moment later
 * fails to appear in anyone's durable history. No money moves, no reputation
 * changes, no row survives.
 *
 * Until now that claim was checked by GREPPING. `fastpath-always-on-smoke`
 * reads the three modules on the route to the event bus and fails if a write
 * statement appears in them. That is a genuinely useful check and it is not the
 * same claim: it says "no INSERT is written in these files", where the
 * invariant says "no row changes anywhere". Those come apart the moment a write
 * happens through a helper the grep does not know to read — which is exactly
 * how the invariant was voided once already in this release, by a remediation
 * that corrected a stale posting key from the chain and wrote it back. That was
 * caught by a fact-check, not by a test.
 *
 * So this one asks the database. It photographs every table in the schema,
 * drives a real signed push through the real route, waits for the verify worker
 * to finish, and asserts two things that have to BOTH hold: the message was
 * delivered (otherwise "nothing changed" is trivially true and means nothing),
 * and not one row anywhere is different.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { federationChatFastRoute } from '../../src/api/federationChatFast';
import { chatEventBus } from '../../src/indexer/chatEventBus';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const SENDER = 'alice';
const RECIPIENT = 'bob';
const senderKey = PrivateKey.fromSeed('morphit-fastpath-writes-nothing-sender');
const senderPub = senderKey.createPublic().toString();

/** The payload shape `apps/web/src/lib/chat/chatService.ts` puts on the wire.
 *  A fixture that invents its own shape proves the path accepts THE FIXTURE. */
function signedChatTx(clientTag: string): unknown {
	const payload = {
		recipient: RECIPIENT,
		ciphertext: Buffer.from('an encrypted message body').toString('base64'),
		header: {
			client_tag: clientTag,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		}
	};
	const ops: unknown[] = [
		[
			'custom_json',
			{
				required_auths: [],
				required_posting_auths: [SENDER],
				id: 'morphit_chat_v1',
				json: JSON.stringify(payload)
			}
		]
	];
	const tx = {
		ref_block_num: 1234,
		ref_block_prefix: 5678,
		expiration: new Date(Date.now() + 45_000).toISOString().slice(0, 19),
		operations: ops,
		extensions: []
	};
	return cryptoUtils.signTransaction(tx as Parameters<typeof cryptoUtils.signTransaction>[0], [
		senderKey
	]);
}

/**
 * A photograph of every row in every table of this schema.
 *
 * Deliberately content-based rather than a row COUNT. A count catches an
 * INSERT and misses an UPDATE — and the write that voided this invariant in
 * practice was an UPDATE, correcting a posting key in place. Counting would
 * have passed.
 */
async function snapshot(fx: IntegrationFixture): Promise<Map<string, string>> {
	const tables = await fx.db.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		  ORDER BY table_name`,
		[fx.schema]
	);
	const shot = new Map<string, string>();
	for (const { table_name } of tables.rows) {
		// to_jsonb of the whole row, ordered by its text form: stable, needs no
		// knowledge of any table's columns or primary key, and notices a changed
		// VALUE as readily as a new row.
		const r = await fx.db.query<{ digest: string | null }>(
			`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest
			   FROM "${fx.schema}"."${table_name}" t`
		);
		shot.set(table_name, r.rows[0]?.digest ?? 'empty');
	}
	return shot;
}

/**
 * Turn the event loop until `done()` holds, or give up after a bounded number
 * of turns. Yields with a ZERO delay — an event-loop hand-off, not a timed
 * wait — so this costs turns rather than wall-clock milliseconds and exits the
 * instant the worker has finished.
 */
async function drain(done: () => boolean, maxTurns = 500): Promise<void> {
	for (let i = 0; i < maxTurns && !done(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

function diff(before: Map<string, string>, after: Map<string, string>): string[] {
	const changed: string[] = [];
	for (const [table, digest] of before) {
		if (after.get(table) !== digest) changed.push(table);
	}
	for (const table of after.keys()) if (!before.has(table)) changed.push(`${table} (new)`);
	return changed;
}

describe.skipIf(!INTEGRATION_ENABLED)('the fast path never writes the database', () => {
	let fx: IntegrationFixture;
	let app: Hono;
	let intake: ReturnType<typeof federationChatFastRoute>;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// The ONE row that has to exist: the sender's posting key, which
		// signature verification reads. Seeded before the snapshot so it is part
		// of the "before" picture rather than a write the push appears to make.
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2)
			   ON CONFLICT (name) DO UPDATE SET posting_pubkey = EXCLUDED.posting_pubkey`,
			[SENDER, senderPub]
		);
		intake = federationChatFastRoute(fx.db);
		app = new Hono();
		app.route('/v1/federation/chat-fast', intake.app ?? (intake as unknown as Hono));
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('delivers a pushed message and changes not one row', async () => {
		const before = await snapshot(fx);

		// `onFast`, not `on`: the fast path emits through `emitFast` into a
		// SEPARATE listener set, because a provisional event and a durable one
		// are different things to a subscriber. Listening on the wrong one gives
		// a silent zero, which is how this assertion first failed.
		const seen: unknown[] = [];
		const off = chatEventBus.onFast((e) => seen.push(e));

		const tag = `live-db-${Date.now()}`;
		const res = await app.request('http://local/v1/federation/chat-fast', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ trx: signedChatTx(tag) })
		});
		// 202: accepted, verification deferred to the worker. That IS the design.
		expect(res.status, 'the peer push must be accepted').toBe(202);

		// Let the verify worker drain. Each iteration is an event-loop YIELD,
		// not a wait: `setTimeout(r, 0)` lets the timers phase hand off to the
		// poll phase, where the worker's database read completes. The loop exits
		// the moment the condition holds, so it costs turns rather than
		// milliseconds — a fixed real-time sleep here would be the CI-flake
		// class `no-real-time-settimeout-in-tests-smoke` exists to ban, and it
		// caught this file when it was first written that way.
		// Wait for the EVENT, not the counter. `verified++` happens before
		// `deliverVerifiedPush` is awaited, so draining on the counter exits one
		// step too early and the bus assertion races it. The real-time sleep this
		// replaced happened to be long enough to hide that; the yield loop made
		// the ordering visible. Wait for the thing being asserted.
		await drain(() => seen.length > 0);

		// BOTH halves matter. Without the first, "nothing changed" is trivially
		// true of a path that did nothing at all.
		expect(
			intake.stats().verified,
			'the message must actually have been verified — otherwise this test proves nothing'
		).toBeGreaterThan(0);
		expect(
			seen.length,
			'and it must have reached the event bus: delivery is the point, the counter is bookkeeping'
		).toBeGreaterThan(0);

		const after = await snapshot(fx);
		expect(
			diff(before, after),
			'ADR-0048 invariant #1: a pushed chat message is DISPLAYED, never persisted'
		).toEqual([]);

		off();
	});

	/**
	 * And the same for a push that FAILS verification, which is the case an
	 * attacker controls. A forged push must leave exactly as little behind as a
	 * good one — no rate-limit row, no audit row, no "seen this account" row,
	 * because any of those is a write an unauthenticated stranger can cause.
	 */
	it('a forged push changes not one row either', async () => {
		const strangerKey = PrivateKey.fromSeed('morphit-fastpath-writes-nothing-stranger');
		const before = await snapshot(fx);

		const payload = {
			recipient: RECIPIENT,
			ciphertext: Buffer.from('forged').toString('base64'),
			header: {
				client_tag: `forged-${Date.now()}`,
				ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
				nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
			}
		};
		const ops: unknown[] = [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [SENDER],
					id: 'morphit_chat_v1',
					json: JSON.stringify(payload)
				}
			]
		];
		const tx = {
			ref_block_num: 1234,
			ref_block_prefix: 5678,
			expiration: new Date(Date.now() + 45_000).toISOString().slice(0, 19),
			operations: ops,
			extensions: []
		};
		// Signed by someone who is NOT the declared sender.
		const forged = cryptoUtils.signTransaction(
			tx as Parameters<typeof cryptoUtils.signTransaction>[0],
			[strangerKey]
		);

		const refusedBefore = intake.stats().refused;
		await app.request('http://local/v1/federation/chat-fast', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ trx: forged })
		});
		await drain(() => intake.stats().refused > refusedBefore);

		expect(
			intake.stats().refused,
			'the forgery must have been REFUSED — otherwise this proves nothing either'
		).toBeGreaterThan(refusedBefore);

		expect(
			diff(before, await snapshot(fx)),
			'a stranger who cannot sign must not be able to cause a write of any kind'
		).toEqual([]);
	});

	/**
	 * v1.18.0 review (R4) — THE ONE WRITE, stated and pinned rather than denied.
	 *
	 * The route's own header said "It will not: write anything", and the audit
	 * said every query on the intake path is a SELECT. Both were false: when the
	 * notify gate passes and the recipient has a push subscription, delivery
	 * enqueues the web push — an INSERT into `push_pending`. The two cases above
	 * never reached it (no reply history, no subscription), so the claim looked
	 * proven. It is the one row the fast path writes, it is keyed on the
	 * transaction id under a unique index, and the relay's sender and janitor
	 * own it from there. Asserted as exactly that: this table and no other, one
	 * row for one message, and none more for the same message again.
	 */
	it('writes exactly one push_pending row for a notifiable message, and nothing else', async () => {
		// An established pair (bob has written to alice), and bob can be notified.
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ($1, $2, 'eA==', '{}'::jsonb, now() - interval '1 day', 'earlier-trx')`,
			[RECIPIENT, SENDER]
		);
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode)
			 VALUES ($1, 'https://push.example/bob', 'p', 'a', 'standard')`,
			[RECIPIENT]
		);
		const before = await snapshot(fx);
		const seen: unknown[] = [];
		const off = chatEventBus.onFast((e) => seen.push(e));
		const tx = signedChatTx(`notify-${Date.now()}`);
		const post = () =>
			app.request('http://local/v1/federation/chat-fast', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ trx: tx })
			});
		expect((await post()).status).toBe(202);
		await drain(() => seen.length > 0);
		// The push enqueue runs after the emit; let it land.
		const pending = async () =>
			Number(
				(
					await fx.db.query<{ n: string }>(
						'SELECT count(*)::text AS n FROM push_pending WHERE account = $1',
						[RECIPIENT]
					)
				).rows[0]?.n ?? '0'
			);
		for (let i = 0; i < 500 && (await pending()) === 0; i++)
			await new Promise((r) => setTimeout(r, 0));
		off();

		expect(seen.length, 'setup: the message must have been delivered').toBeGreaterThan(0);
		expect(
			diff(before, await snapshot(fx)),
			'push_pending is the ONLY table the fast path writes'
		).toEqual(['push_pending']);
		expect(await pending(), 'one notification for one message').toBe(1);

		// The same message again — a second peer, a replay — adds nothing.
		await post();
		for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
		expect(await pending(), 'a second delivery of the same message enqueued another push').toBe(1);
	});
});
