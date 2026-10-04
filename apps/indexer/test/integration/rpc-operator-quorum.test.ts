/**
 * the posting-key quorum counts OPERATORS.
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
			// The attacker's key is never written: its two addresses are one vote.
			// Its lone dissent delays this round (VT5-1: it is not provably older),
			// so nothing is confirmed yet and the reconcile asks again.
			expect(row.posting_pubkey).toBe(VICTIM_PUB);
			expect(row.posting_key_reconciled).toBe(false);
			expect(r.remaining).toBe(1);
		});

		it('two honest operators confirm a key when nobody disagrees (rv2-2)', async () => {
			const g1 = await make('127.0.0.1', VICTIM_PUB, 50);
			const g2 = await make('127.0.0.1', VICTIM_PUB, 50);
			const blurt = client(g1, g2);
			blurt.mergeRpcEndpoints([g1.url, g2.url], { [g1.url]: 'good-1', [g2.url]: 'good-2' });
			await reconcilePostingKeys(fx.db, blurt, { pauseMs: 0 });
			const row = (await fx.db.query('SELECT posting_pubkey, posting_key_reconciled FROM accounts'))
				.rows[0]!;
			expect(row.posting_pubkey).toBe(VICTIM_PUB);
			expect(row.posting_key_reconciled).toBe(true);
		});

		it('a blip on the other operators never leaves one operator to confirm a key alone', async () => {
			// A is hostile and fast; B and C are honest and fail ONE call each (a
			// Tor blip), which used to drop the quorum to one operator: A's.
			const blips = new Set<string>();
			const servers: http.Server[] = [];
			const mk = async (host: string, key: string, honest: boolean): Promise<string> => {
				const server = http.createServer((req, res) => {
					let body = '';
					req.on('data', (c) => (body += c));
					req.on('end', () => {
						const j = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown[] };
						const m = j.method === 'call' ? String(j.params?.[1]) : String(j.method);
						if (honest && !blips.has(host)) {
							blips.add(host);
							res.writeHead(502);
							res.end();
							return;
						}
						const auth = { weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] };
						const result = m.includes('get_accounts')
							? [{ name: 'alice', posting: auth, owner: auth, active: auth, memo_key: key }]
							: {
									head_block_number: 1,
									last_irreversible_block_num: 1,
									time: '2026-10-01T00:00:00'
								};
						setTimeout(
							() => {
								if (res.destroyed) return;
								res.writeHead(200, { 'content-type': 'application/json' });
								res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }));
							},
							honest ? 150 : 1
						);
					});
				});
				servers.push(server);
				await new Promise<void>((r) => server.listen(0, host, () => r()));
				return `http://${host}:${(server.address() as { port: number }).port}`;
			};
			const a = await mk('127.0.0.21', ATTACKER_PUB, false);
			const b = await mk('127.0.0.22', VICTIM_PUB, true);
			const c = await mk('127.0.0.23', VICTIM_PUB, true);
			try {
				const blurt = new BlurtClient({
					localRpcEndpoints: [a, b, c],
					blurtRpcEndpoints: []
				} as never);
				for (let i = 0; i < 3; i++) {
					await (blurt as unknown as { getDynamicGlobalProperties(): Promise<unknown> })
						.getDynamicGlobalProperties()
						.catch(() => undefined);
				}
				expect(blips.size, 'both honest operators blipped once').toBe(2);
				const agreed = await blurt.getAccountsAgreed(['alice'], agreeOn);
				const key = agreed === null ? null : primaryPostingKey(agreed.get('alice')!);
				expect(key, 'one operator decided a trusted key').not.toBe(ATTACKER_PUB);
				// Its lone dissent delays the read (VT5-1); it never decides it.
				expect(agreed).toBeNull();
			} finally {
				for (const s2 of servers) {
					s2.closeAllConnections?.();
					s2.close();
				}
			}
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
			'a pool with one working operator and one dead one answers nothing it would trust',
			{ timeout: 40_000 },
			async () => {
				// rv2-9 sized this quorum from the reachable count, so after one
				// failed read the working operator decided alone. Two operators exist,
				// so two must agree: until the other answers, there is no answer.
				const dead: Stub = { url: 'http://127.0.0.5:9', hits: 0, close: async () => {} };
				const g = await make('127.0.0.6', VICTIM_PUB, 1);
				const blurt = client(dead, g);
				await blurt.getAccountsAgreed(['alice'], agreeOn);
				const second = await blurt.getAccountsAgreed(['alice'], agreeOn);
				expect(second).toBeNull();
			}
		);

		it('a pool of ONE operator is its own quorum', async () => {
			const g = await make('127.0.0.12', VICTIM_PUB, 1);
			const m = await client(g).getAccountsAgreed(['alice'], agreeOn);
			expect(m).not.toBeNull();
			expect(primaryPostingKey(m!.get('alice')!)).toBe(VICTIM_PUB);
		});

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
