/**
 * VT5-1 — the posting-key reconcile never confirms a STALE key over a more
 * current answer.
 *
 * Alice's key leaked and she rotated it; the dispatcher recorded CURRENT from
 * the block, unconfirmed. The reconcile then asks the chain's nodes. A node
 * that has not applied the rotation yet still names LEAKED, and so may a
 * hostile one. A bare majority of whoever answered first used to confirm
 * LEAKED — for good, since a confirmed row is never asked about again.
 *
 * Now a key is confirmed only when no answering operator still disagrees in a
 * way that could be newer: such a dissent delays the confirmation, more
 * operators are asked, and the row stays unconfirmed (and is asked again)
 * until the nodes agree.
 *
 * Real reconcile, real BlurtClient and rpc pool, real Postgres; fake JSON-RPC
 * nodes, one per loopback address (one operator each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { BlurtClient } from '../../src/blurt/client';
import { reconcilePostingKeys } from '../../src/indexer/postingKeyBackfill';

const ACCOUNT = 'alice';
// Shape-valid public keys are not needed: the reconcile compares strings.
const LEAKED = 'BLT_leaked_key_the_owner_rotated_away_from';
const CURRENT = 'BLT_current_key_the_chain_names_today';

interface FakeRpc {
	readonly url: string;
	close(): Promise<void>;
}

/** A JSON-RPC endpoint answering `get_accounts` with `key` as alice's posting
 *  key — or omitting her entirely when `key` is undefined — after `latencyMs`.
 *  A function is asked on every request (a node that catches up). */
async function fakeRpc(
	keyOrNow: string | undefined | (() => string | undefined),
	latencyMs: number
): Promise<FakeRpc> {
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let id: unknown = 0;
			try {
				id = (JSON.parse(body) as { id?: unknown }).id ?? 0;
			} catch {
				/* default id */
			}
			const key = typeof keyOrNow === 'function' ? keyOrNow() : keyOrNow;
			const auth = (k: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] });
			const result = body.includes('get_accounts')
				? key === undefined
					? []
					: [
							{
								name: ACCOUNT,
								balance: '0.000 BLURT',
								memo_key: key,
								owner: auth(key),
								active: auth(key),
								posting: auth(key)
							}
						]
				: body.includes('get_dynamic_global_properties')
					? { head_block_number: 1, last_irreversible_block_num: 1, time: '2026-09-24T00:00:00' }
					: null;
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
			}, latencyMs);
		});
	});
	// the quorum counts OPERATORS, and two ports on
	// one host are one operator. Each fake node here stands for an independent
	// operator, so each gets its own loopback address.
	const host = `127.0.0.${nextHost++}`;
	await new Promise<void>((r) => server.listen(0, host, () => r()));
	const addr = server.address();
	if (addr === null || typeof addr === 'string') throw new Error('no address');
	return {
		url: `http://${host}:${addr.port}`,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections?.();
				server.close(() => r());
			})
	};
}

let nextHost = 130;

describe.skipIf(!INTEGRATION_ENABLED)('a stale majority never undoes a rotation (VT5-1)', () => {
	let fx: IntegrationFixture;
	let servers: FakeRpc[] = [];
	const row = async () =>
		(
			await fx.db.query<{ posting_pubkey: string | null; posting_key_reconciled: boolean }>(
				'SELECT posting_pubkey, posting_key_reconciled FROM accounts WHERE name = $1',
				[ACCOUNT]
			)
		).rows[0] ?? null;
	const client = (...eps: FakeRpc[]): BlurtClient => {
		servers.push(...eps);
		return new BlurtClient({ blurtRpcEndpoints: eps.map((e) => e.url) } as never);
	};
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query('DELETE FROM accounts');
		// The owner rotated away from LEAKED; the dispatcher recorded CURRENT from the block, unconfirmed.
		await fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey, posting_key_reconciled)
			VALUES ($1, 'genesis', 1, now(), 'seed', $2, FALSE)`,
			[ACCOUNT, CURRENT]
		);
	});
	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		servers = [];
	});
	for (const [title, specs] of [
		[
			'ONE hostile operator (answers LEAKED) + one lagging honest node, vs two up-to-date',
			[
				[LEAKED, 5],
				[CURRENT, 20],
				[LEAKED, 40],
				[CURRENT, 60]
			]
		],
		[
			'no attacker: the two fastest of three are behind',
			[
				[LEAKED, 5],
				[LEAKED, 20],
				[CURRENT, 40]
			]
		]
	] as const) {
		it(title, async () => {
			const eps = [] as FakeRpc[];
			for (const [k, ms] of specs) eps.push(await fakeRpc(k, ms));
			const c = client(...eps);
			const r1 = await reconcilePostingKeys(fx.db, c, { pauseMs: 0 });
			// Pass 1: the stale answer is NOT confirmed; the row waits, unconfirmed.
			expect(await row()).toEqual({ posting_pubkey: CURRENT, posting_key_reconciled: false });
			expect(r1.remaining).toBe(1);
			// The up-to-date operator is not punished for being ahead.
			expect(c.quorumDissent()).toEqual([]);
			// Pass 2: every node has caught up — the current key is confirmed.
			const current = await Promise.all([
				fakeRpc(CURRENT, 5),
				fakeRpc(CURRENT, 10),
				fakeRpc(CURRENT, 15)
			]);
			await reconcilePostingKeys(fx.db, client(...current), { pauseMs: 0 });
			expect(await row()).toEqual({ posting_pubkey: CURRENT, posting_key_reconciled: true });
		});
	}
});
