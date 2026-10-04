/**
 * v1.18.0 review — D1 and D7: the posting-key reconcile writes CONFIRMED keys,
 * so it must not take one endpoint's word for them.
 *
 * WHY THIS MATTERS. Since v1.18.0, `accounts.posting_pubkey` is what a pushed
 * chat message is verified against, and a row marked `posting_key_reconciled`
 * is trusted with no further chain read — ever, until the owner's next
 * `account_update`. The reconcile that sets that flag used to ask ONE endpoint.
 * The pool includes community nodes and nodes from the on-chain directory, and
 * any node can simply be behind: one that still names the key an owner rotated
 * away from because it leaked would confirm the leaked key, permanently. That is
 * precisely the state the reconcile exists to end (F37).
 *
 * So: the REAL reconcile, the REAL BlurtClient and its REAL rpc pool, a REAL
 * database, and three fake JSON-RPC endpoints whose answers we choose. The
 * lagging one is the FASTEST, which is the node a single-endpoint read picks.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { BlurtClient } from '../../src/blurt/client';
import {
	distrustRestoredPostingKeys,
	keepReconcilingPostingKeys,
	reconcilePostingKeys,
	type AccountKeySource,
	type ReconcileResult
} from '../../src/indexer/postingKeyBackfill';

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

let nextHost = 20;

describe.skipIf(!INTEGRATION_ENABLED)('the reconcile trusts only an AGREED answer', () => {
	let fx: IntegrationFixture;
	let servers: FakeRpc[] = [];

	const row = async () => {
		const r = await fx.db.query<{ posting_pubkey: string | null; posting_key_reconciled: boolean }>(
			'SELECT posting_pubkey, posting_key_reconciled FROM accounts WHERE name = $1',
			[ACCOUNT]
		);
		return r.rows[0] ?? null;
	};

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
		// A row as a pre-v1.18.0 indexer wrote it: the key first seen, not yet
		// confirmed.
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id,
			      posting_pubkey, posting_key_reconciled)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2, FALSE)`,
			[ACCOUNT, LEAKED]
		);
	});
	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		servers = [];
	});

	it('one lagging endpoint cannot confirm the leaked key', async () => {
		// The lagging node is the fastest — the one a single-endpoint read uses.
		const lagging = await fakeRpc(LEAKED, 5);
		const honest = await fakeRpc(CURRENT, 60);
		const r = await reconcilePostingKeys(fx.db, client(lagging, honest), { pauseMs: 0 });
		expect(
			await row(),
			'a single node that is behind confirmed the key the owner rotated away from — permanently'
		).toEqual({ posting_pubkey: LEAKED, posting_key_reconciled: false });
		expect(r.remaining, 'the row is counted as still to do, so it is asked about again').toBe(1);
	});

	it('a node that disagrees delays the confirmation; once it agrees, the key is confirmed', async () => {
		// VT5-1: a dissent that is not provably older (these answers carry no
		// last_account_update) is not outvoted on the spot — it may be the one
		// node that has applied a rotation. The row stays unconfirmed and is
		// asked again; nothing is decided against it.
		let lagKey = LEAKED;
		const lagging = await fakeRpc(() => lagKey, 5);
		const honest1 = await fakeRpc(CURRENT, 40);
		const honest2 = await fakeRpc(CURRENT, 60);
		const blurt = client(lagging, honest1, honest2);
		const first = await reconcilePostingKeys(fx.db, blurt, { pauseMs: 0 });
		expect(await row()).toEqual({ posting_pubkey: LEAKED, posting_key_reconciled: false });
		expect(first.remaining).toBe(1);
		lagKey = CURRENT;
		const r = await reconcilePostingKeys(fx.db, blurt, { pauseMs: 0 });
		expect(await row()).toEqual({ posting_pubkey: CURRENT, posting_key_reconciled: true });
		expect(r).toEqual({ checked: 1, corrected: 1, remaining: 0 });
	});

	it('an endpoint that does not know the account disagrees rather than abstains', async () => {
		// Two answers that each "agree there is no key" would clear it. One of
		// them does not know the account at all: that is not agreement.
		const behind = await fakeRpc(undefined, 5);
		const honest = await fakeRpc(CURRENT, 60);
		await reconcilePostingKeys(fx.db, client(behind, honest), { pauseMs: 0 });
		expect((await row())?.posting_key_reconciled).toBe(false);
	});

	it('a single-endpoint source that omits the account leaves the row alone (D7)', async () => {
		// Before: a missing account was read as "no key" and written NULL +
		// confirmed, so a node that did not know newer accounts cleared the keys
		// of a whole batch of them.
		const omitting: AccountKeySource = { getAccounts: async () => new Map() };
		const r = await reconcilePostingKeys(fx.db, omitting, { pauseMs: 0 });
		expect(await row()).toEqual({ posting_pubkey: LEAKED, posting_key_reconciled: false });
		expect(r.remaining).toBe(1);
	});

	/**
	 * D5 — the reconcile ran ONCE per boot. On a hidden-only box whose Tor was
	 * still building circuits it failed every batch in seconds, and the rows then
	 * waited for the next restart — weeks, possibly — with every sender costing
	 * the fast path a budgeted chain read meanwhile.
	 */
	it('a pass that could not confirm is retried until it can, then stops', async () => {
		let calls = 0;
		const flaky: AccountKeySource = {
			getAccounts: async (names) => {
				calls++;
				if (calls < 3) throw new Error('rpc not ready yet');
				return new Map(
					names.map((n) => [
						n,
						{ posting: { weight_threshold: 1, key_auths: [[CURRENT, 1]] as [string, number][] } }
					])
				);
			}
		};
		const passes: ReconcileResult[] = [];
		const stop = keepReconcilingPostingKeys(fx.db, flaky, {
			firstDelayMs: 5,
			maxDelayMs: 20,
			onPass: (r) => passes.push(r)
		});
		try {
			const until = performance.now() + 5_000;
			while (performance.now() < until && (await row())?.posting_key_reconciled !== true) {
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(await row(), 'the retry never got the row confirmed').toEqual({
				posting_pubkey: CURRENT,
				posting_key_reconciled: true
			});
			const settled = calls;
			// Several multiples of the (20 ms) retry ceiling, in short yields —
			// a loop that had not stopped would ask again inside this.
			for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 5));
			expect(calls, 'once nothing is left to confirm, the retry must stop asking').toBe(settled);
			expect(passes.at(-1)?.remaining).toBe(0);
		} finally {
			stop();
		}
	});

	/**
	 * D4 — a fast-sync restores another instance's database, confirmations and
	 * all. The snapshot's integrity check covers the `ops` log; posting keys are
	 * not derived from it, so a publisher's confirmed key was trusted here on the
	 * publisher's word.
	 */
	it('a restored snapshot brings no confirmations with it', async () => {
		await fx.db.query('UPDATE accounts SET posting_key_reconciled = TRUE');
		const n = await distrustRestoredPostingKeys(fx.db);
		expect(n).toBe(1);
		expect(
			(await row())?.posting_key_reconciled,
			"a restored row stayed confirmed — the fast path would trust the publisher's key without asking"
		).toBe(false);
	});
});
