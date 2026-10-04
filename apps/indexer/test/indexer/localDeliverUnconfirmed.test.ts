/**
 * VT1-4 — /v1/broadcast delivers a chat message to this instance's own
 * listeners only when its signature verifies against a CONFIRMED posting key.
 *
 *
 * The broadcast goes to ONE pool node. A node that "accepts" a transaction
 * naming @alice but signed with Mallory's key used to be enough for the
 * message to reach Bob's open chat, live, as from alice — and to be recorded
 * as an alice→bob pair. Now a message is delivered locally only if it
 * verifies against our own record of alice's posting key; anything else waits
 * for the head tailer, which reads it from a block.
 *
 * The key on file may be UNCONFIRMED: an account_update in a block is one RPC
 * node's word, and the dispatcher records it with posting_key_reconciled =
 * FALSE. Such a key must never authenticate a local delivery — not through the
 * lookup main.ts wires in, and not through the dispatcher's default lookup.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import { broadcastRoute } from '$api/broadcast';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import { postingKeyLookupFromDb } from '$indexer/chatFastFederation';
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

const MALLORY_PUB = MALLORY.createPublic('BLT').toString();
const acceptingNode = {
	callCondenser: async () => ({ id: 'a'.repeat(40) })
} as unknown as BlurtClient;

/** The dispatcher with the lookup it builds itself (or, with `asMainBuildsIt`,
 *  the one main.ts passes); alice's row as given. */
function dispatcherWithRow(
	row: { posting_pubkey: string; posting_key_reconciled: boolean },
	asMainBuildsIt = false
): ChatFastDispatcher {
	const db = {
		async query<R extends pg.QueryResultRow>(sql: string): Promise<pg.QueryResult<R>> {
			const rows = /FROM accounts/.test(sql) ? [row] : [];
			return {
				rows,
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as unknown as pg.QueryResult<R>;
		}
	};
	return new ChatFastDispatcher({
		// As main.ts wires it: the shared lookup with the quorum refresher (which
		// answers with the attacker's key, should it ever be asked here).
		...(asMainBuildsIt
			? {
					lookupPostingKey: postingKeyLookupFromDb(db, async () => MALLORY_PUB, {
						durableIsCurrent: () => true
					})
				}
			: {}),
		db,
		selfOrigin: 'http://self.invalid',
		proxies: { torSocks: '', i2pHttpProxy: '' },
		postIsolated: async () => ({ status: 200, body: '{}' })
	});
}

async function deliveredVia(
	d: ChatFastDispatcher,
	signer: InstanceType<typeof PrivateKey>,
	tag: string
) {
	const delivered: LocatedChatOp[] = [];
	const app = broadcastRoute(acceptingNode, d, (l) => delivered.push(l));
	await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trx: chatTrx(signer, tag), chat_async: true })
	});
	return delivered.map((d2) => `${d2.signer}->${d2.recipient}`);
}

describe('local delivery never trusts an unconfirmed posting key (VT1-4)', () => {
	it('a message signed by an UNCONFIRMED key on file is not delivered locally', async () => {
		const d = dispatcherWithRow({ posting_pubkey: MALLORY_PUB, posting_key_reconciled: false });
		expect(await deliveredVia(d, MALLORY, 'forged-unconfirmed')).toEqual([]);
	});

	it('a message signed by the CONFIRMED key is delivered at once', async () => {
		const d = dispatcherWithRow({ posting_pubkey: ALICE_PUB, posting_key_reconciled: true });
		expect(await deliveredVia(d, ALICE, 'genuine')).toEqual(['alice->bob']);
	});

	it('with the lookup main.ts wires in, an unconfirmed key is not trusted either', async () => {
		const d = dispatcherWithRow(
			{ posting_pubkey: MALLORY_PUB, posting_key_reconciled: false },
			true
		);
		expect(await deliveredVia(d, MALLORY, 'forged-main')).toEqual([]);
	});

	it('the genuine key, still unconfirmed, waits for the chain too', async () => {
		const d = dispatcherWithRow({ posting_pubkey: ALICE_PUB, posting_key_reconciled: false });
		expect(await deliveredVia(d, ALICE, 'genuine-unconfirmed')).toEqual([]);
	});
});
