/**
 * v1.18.0 deep-deep (rv2-2, rv2-9) — the posting-key quorum counts OPERATORS.
 *
 * Real BlurtClient + real rpc pool + real reconcile against a real Postgres,
 * with local JSON-RPC stubs standing in for the chain's nodes.
 *
 *   rv2-2: one operator listed at two addresses (every hidden node has an
 *          .onion and a .b32.i2p) used to meet the two-endpoint quorum alone
 *          and write its own key as CONFIRMED.
 *   rv2-9: the quorum's size came from the configured pool, so one working
 *          node plus an unreachable one never reached quorum; and every quorum
 *          batch went to every endpoint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { BlurtClient } from '../../src/blurt/client';
import { reconcilePostingKeys, primaryPostingKey } from '../../src/indexer/postingKeyBackfill';

const { PrivateKey } = await import('@beblurt/dblurt');
const VICTIM_PUB = PrivateKey.fromSeed('rpc-op-quorum-victim').createPublic().toString();
const ATTACKER_PUB = PrivateKey.fromSeed('rpc-op-quorum-attacker').createPublic().toString();

interface Stub {
	url: string;
	hits: number;
	close(): Promise<void>;
}

/** A condenser get_accounts stub on `host`, answering after `latencyMs`. */
async function stub(host: string, key: string, latencyMs: number): Promise<Stub> {
	const s: Stub = { url: '', hits: 0, close: async () => {} };
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			s.hits++;
			const j = JSON.parse(body) as { id?: unknown; params?: unknown };
			const names = (JSON.stringify(j.params).match(/"[a-z][a-z0-9.-]+"/g) ?? [])
				.map((x) => x.slice(1, -1))
				.filter((n) => n !== 'condenser_api' && n !== 'get_accounts');
			const auth = { weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] };
			const result = names.map((name) => ({
				name,
				posting: auth,
				owner: auth,
				active: auth,
				memo_key: key
			}));
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }));
			}, latencyMs);
		});
	});
	await new Promise<void>((r) => server.listen(0, host, () => r()));
	const a = server.address() as { port: number };
	s.url = `http://${host}:${a.port}`;
	s.close = () =>
		new Promise<void>((r) => {
			server.closeAllConnections?.();
			server.close(() => r());
		});
	return s;
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'rpc quorum counts operators, not URLs (rv2-2, rv2-9)',
	() => {
		let fx: IntegrationFixture;
		let stubs: Stub[] = [];
		const client = (...eps: Stub[]): BlurtClient =>
			new BlurtClient({ localRpcEndpoints: eps.map((e) => e.url), blurtRpcEndpoints: [] } as never);
		const agreeOn = (a: Parameters<typeof primaryPostingKey>[0] | undefined): string =>
			a ? (primaryPostingKey(a) ?? 'none') : 'unknown';

		beforeAll(async () => {
			process.env.MORPHIT_RPC_HEALTH_STATE = join(
				mkdtempSync(join(tmpdir(), 'rpcq-')),
				'health.json'
			);
			fx = await setupWithMigrations();
		});
		afterAll(async () => fx?.teardown());
		beforeEach(async () => {
			await fx.db.query('DELETE FROM accounts');
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey, posting_key_reconciled)
			 VALUES ('alice', 'x', 1, now(), 't', $1, FALSE)`,
				[VICTIM_PUB]
			);
		});
		afterEach(async () => {
			await Promise.all(stubs.map((s) => s.close()));
			stubs = [];
		});
		const make = async (host: string, key: string, latencyMs: number): Promise<Stub> => {
			const s = await stub(host, key, latencyMs);
			stubs.push(s);
			return s;
		};

		it('one operator at two directory addresses cannot confirm its key (rv2-2)', async () => {
			const g1 = await make('127.0.0.1', VICTIM_PUB, 300);
			const g2 = await make('127.0.0.1', VICTIM_PUB, 300);
			const evilOnion = await make('127.0.0.1', ATTACKER_PUB, 1);
			const evilI2p = await make('127.0.0.1', ATTACKER_PUB, 1);
			// Honest ones are two distinct operators here; the stubs share a host,
			// so name them explicitly, as the directory names its nodes.
			const blurt = client(g1, g2);
			blurt.mergeRpcEndpoints([g1.url, g2.url], { [g1.url]: 'good-1', [g2.url]: 'good-2' });
			blurt.mergeRpcEndpoints([evilOnion.url, evilI2p.url], {
				[evilOnion.url]: 'evil',
				[evilI2p.url]: 'evil'
			});
			const r = await reconcilePostingKeys(fx.db, blurt, { pauseMs: 0 });
			const row = (await fx.db.query('SELECT posting_pubkey, posting_key_reconciled FROM accounts'))
				.rows[0]!;
			expect(row.posting_pubkey).toBe(VICTIM_PUB);
			expect(row.posting_key_reconciled).toBe(true);
			expect(r.checked).toBe(1);
		});

		it('two ports on one host are one operator by default (rv2-2)', async () => {
			const evilA = await make('127.0.0.2', ATTACKER_PUB, 1);
			const evilB = await make('127.0.0.2', ATTACKER_PUB, 1);
			const g1 = await make('127.0.0.3', VICTIM_PUB, 250);
			const g2 = await make('127.0.0.4', VICTIM_PUB, 250);
			const blurt = client(evilA, g1, evilB, g2);
			await reconcilePostingKeys(fx.db, blurt, { pauseMs: 0 });
			const row = (await fx.db.query('SELECT posting_pubkey FROM accounts')).rows[0]!;
			expect(row.posting_pubkey).toBe(VICTIM_PUB);
		});

		it(
			'a pool with one working operator and one dead one still reaches an answer (rv2-9)',
			{ timeout: 40_000 },
			async () => {
				const dead: Stub = { url: 'http://127.0.0.5:9', hits: 0, close: async () => {} };
				const g = await make('127.0.0.6', VICTIM_PUB, 1);
				const blurt = client(dead, g);
				// First read: both are presumed reachable, so two must agree; the dead
				// one fails and is then known to be failing.
				await blurt.getAccountsAgreed(['alice'], agreeOn);
				const second = await blurt.getAccountsAgreed(['alice'], agreeOn);
				expect(second).not.toBeNull();
				expect(primaryPostingKey(second!.get('alice')!)).toBe(VICTIM_PUB);
			}
		);

		it('fan-out is capped: five agreeing operators, at most three asked (rv2-9)', async () => {
			const eps = await Promise.all(
				['127.0.0.7', '127.0.0.8', '127.0.0.9', '127.0.0.10', '127.0.0.11'].map((h) =>
					make(h, VICTIM_PUB, 20)
				)
			);
			const blurt = client(...eps);
			const m = await blurt.getAccountsAgreed(['alice'], agreeOn);
			expect(m).not.toBeNull();
			expect(eps.reduce((n, e) => n + e.hits, 0)).toBeLessThanOrEqual(3);
		});
	}
);
