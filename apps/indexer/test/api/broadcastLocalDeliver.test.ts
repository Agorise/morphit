/**
 * /v1/broadcast delivers a chat message to this instance's own listeners only
 * when its signature verifies here.
 *
 * The broadcast goes to ONE pool node. A node that "accepts" a transaction
 * naming @alice but signed with Mallory's key used to be enough for the
 * message to reach Bob's open chat, live, as from alice — and to be recorded
 * as an alice→bob pair. Now a message is delivered locally only if it
 * verifies against our own record of alice's posting key; anything else waits
 * for the head tailer, which reads it from a block.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import { broadcastRoute } from '$api/broadcast';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import { CLIENT_EXPIRY_LEAD_MS } from '$indexer/chatFastFederation';
import type { LocatedChatOp } from '$indexer/headTailer';
import type { BlurtClient } from '$blurt/client';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const ALICE = PrivateKey.fromSeed('alice-test-posting-key');
const MALLORY = PrivateKey.fromSeed('mallory-not-alice');
const ALICE_PUB = ALICE.createPublic('BLT').toString();

function chatTrx(signer: InstanceType<typeof PrivateKey>, tag: string): unknown {
	return cryptoUtils.signTransaction(
		{
			ref_block_num: 1,
			ref_block_prefix: 2,
			expiration: new Date(Date.now() + 50_000).toISOString().slice(0, 19),
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['alice'],
						id: 'morphit_chat_v1',
						json: JSON.stringify({
							recipient: 'bob',
							ciphertext: Buffer.from(`hello ${tag}`).toString('base64'),
							header: { client_tag: tag }
						})
					}
				]
			],
			extensions: []
		} as never,
		[signer] as never
	);
}

/** A pool node that says "accepted" to anything. */
const acceptingNode = {
	callCondenser: async () => ({ id: 'a'.repeat(40) })
} as unknown as BlurtClient;

function dispatcher(): ChatFastDispatcher {
	return new ChatFastDispatcher({
		db: {
			async query<R extends pg.QueryResultRow>(): Promise<pg.QueryResult<R>> {
				return {
					rows: [],
					rowCount: 0,
					command: 'SELECT',
					oid: 0,
					fields: []
				} as pg.QueryResult<R>;
			}
		},
		selfOrigin: 'http://self.invalid',
		proxies: { torSocks: '', i2pHttpProxy: '' },
		lookupPostingKey: async (account) => (account === 'alice' ? ALICE_PUB : null),
		postIsolated: async () => ({ status: 200, body: '{}' })
	});
}

async function send(
	trx: unknown
): Promise<{ status: number; delivered: LocatedChatOp[]; sentAt: Date[] }> {
	const delivered: LocatedChatOp[] = [];
	const sentAt: Date[] = [];
	const app = broadcastRoute(acceptingNode, dispatcher(), (located, _id, at) => {
		delivered.push(located);
		sentAt.push(at);
	});
	const res = await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trx, chat_async: true })
	});
	// A message verified before the chain is delivered before the answer; one
	// checked after the node accepted it, a few turns of the event loop later
	// (v1.21.14). Nothing here does I/O, so yielding is enough.
	for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
	return { status: res.status, delivered, sentAt };
}

describe('local chat delivery from /v1/broadcast', () => {
	it('a message alice really signed is delivered to local listeners', async () => {
		const r = await send(chatTrx(ALICE, 'real1'));
		expect(r.status).toBe(200);
		expect(r.delivered.map((d) => `${d.signer}->${d.recipient}`)).toEqual(['alice->bob']);
	});

	it("is stamped with the sender's time from the signed expiry, as a peer's push of it is (S-L1)", async () => {
		const trx = chatTrx(ALICE, 'real-time') as { expiration: string };
		const r = await send(trx);
		expect(r.sentAt.map((d) => d.getTime())).toEqual([
			Date.parse(trx.expiration + 'Z') - CLIENT_EXPIRY_LEAD_MS
		]);
	});

	it('a message naming alice but signed by another key is NOT, though the node accepted it', async () => {
		const r = await send(chatTrx(MALLORY, 'forged1'));
		expect(r.status, 'the send itself still succeeds — the chain decides').toBe(200);
		expect(r.delivered).toEqual([]);
	});
});
