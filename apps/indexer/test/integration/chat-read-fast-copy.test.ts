/**
 * v1.24.1 — a read ack of a message's fast copy covers the message's row.
 *
 * A device that read a message before its block was applied (the fast path)
 * acked the sender's signed time; the row is dated by the block, a few seconds
 * later. Every other device of the reader showed the thread unread once the
 * row landed. /v1/chat-read-state gives such an ack as the block time of the
 * message it read (chat_messages.sent_at, migration v74), and nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatReadStateRoute } from '../../src/api/chatReadState';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const S = '2026-11-10T03:00:00.000Z'; // the signed time (a head block's time)
const plus = (iso: string, s: number): string => new Date(Date.parse(iso) + s * 1000).toISOString();

describe.skipIf(!INTEGRATION_ENABLED)('read ack of a fast copy (v74 sent_at)', () => {
	let fx: IntegrationFixture;
	let n = 0;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query('TRUNCATE chat_read_state');
	});

	const message = (o: {
		createdAt: string;
		sentAt: string | null;
		order?: string | null;
		sender?: string;
	}) =>
		fx.db.query(
			`INSERT INTO chat_messages
				(sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink, sent_at)
			 VALUES ($1, $2, 'c', '{}'::jsonb, $3, $4, $5, $6)`,
			[
				o.sender ?? 'peer',
				o.sender === 'reader' ? 'peer' : 'reader',
				o.createdAt,
				`trx${++n}`,
				o.order === undefined ? 'sell-1' : o.order,
				o.sentAt
			]
		);
	const ack = (at: string, order = 'sell-1') =>
		fx.db.query(
			`INSERT INTO chat_read_state
				(reader_account, peer_account, order_permlink, last_read_at, source_block_num, source_trx_id)
			 VALUES ('reader', 'peer', $1, $2, 1, $3)`,
			[order, at, `ack${++n}`]
		);
	const answered = async (order = 'sell-1'): Promise<string | undefined> => {
		const res = await chatReadStateRoute(fx.db).request('/reader');
		const body = (await res.json()) as {
			items: { peer: string; order_permlink: string; last_read_at: string }[];
		};
		return body.items.find((i) => i.order_permlink === order)?.last_read_at;
	};

	it('an ack of a fast copy is given as that message’s block time', async () => {
		await message({ createdAt: plus(S, 4), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(plus(S, 4));
	});

	it('the earliest such message is the one read', async () => {
		await message({ createdAt: plus(S, 4), sentAt: S });
		await message({ createdAt: plus(S, 30), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(plus(S, 4));
	});

	it('an ack that is a message’s own block time stays what it is', async () => {
		// The signed time is a head block's time, so a row can carry the same
		// instant: this ack read THAT row, and the later message is unread.
		await message({ createdAt: S, sentAt: plus(S, -3) });
		await message({ createdAt: plus(S, 4), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(S);
	});

	it('a message landing more than 75 s after its signed time is not taken', async () => {
		await message({ createdAt: plus(S, 90), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(S);
	});

	it('only a message of the same discussion is taken', async () => {
		await message({ createdAt: plus(S, 4), sentAt: S, order: 'other-order' });
		await message({ createdAt: plus(S, 5), sentAt: S, order: null });
		await ack(S);
		expect(await answered()).toBe(S);
		await ack(S, '');
		expect(await answered('')).toBe(plus(S, 5));
	});

	it('another message signed after the one read, landing with it, keeps the ack (never hide it)', async () => {
		// The message read missed a block and landed with the next, together
		// with the peer's next message, which the reader has not seen.
		await message({ createdAt: plus(S, 6), sentAt: S });
		await message({ createdAt: plus(S, 6), sentAt: plus(S, 3) });
		await ack(S);
		expect(await answered()).toBe(S);
	});

	it('two messages signed in the same head block keep the ack, and so does one of unknown time', async () => {
		await message({ createdAt: plus(S, 3), sentAt: S });
		await message({ createdAt: plus(S, 3), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(S);
		await fx.db.query('TRUNCATE chat_messages');
		await message({ createdAt: plus(S, 3), sentAt: S });
		await message({ createdAt: plus(S, 3), sentAt: null });
		expect(await answered()).toBe(S);
	});

	it('acking the reader’s own message signed in the same head block leaves the peer’s unread', async () => {
		await message({ createdAt: plus(S, 2), sentAt: S, sender: 'reader' });
		await message({ createdAt: plus(S, 4), sentAt: S });
		await ack(S);
		expect(await answered()).toBe(plus(S, 2));
	});

	it('the reader’s own message in that stretch does not keep it', async () => {
		await message({ createdAt: plus(S, 3), sentAt: S });
		await message({ createdAt: plus(S, 3), sentAt: plus(S, 1), sender: 'reader' });
		await ack(S);
		expect(await answered()).toBe(plus(S, 3));
	});

	it('a legacy peer-wide ack, a row without sent_at, and a later message leave the ack alone', async () => {
		await message({ createdAt: plus(S, 4), sentAt: null });
		await message({ createdAt: plus(S, 6), sentAt: plus(S, 3) });
		await ack(S);
		expect(await answered()).toBe(S);
		await message({ createdAt: plus(S, 9), sentAt: S, order: 'sell-2' });
		await ack(S, '*');
		expect(await answered('*')).toBe(S);
	});
});
