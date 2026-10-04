/**
 * the standalone chain scripts, run as an operator runs them.
 *
 * the Tier-2 snapshot check (scripts/snapshot-verify-oplog.ts) took the
 * OLDEST 5,000 applied ops and spread a fixed sample over them, and never
 * looked at `orders`, yet reported "Snapshot op log matches the chain". A
 * forged op newer than those 5,000 — or a forged `orders` row with no op
 * behind it — passed (IX2 oplog). It must exit 3 (QUARANTINE).
 *
 * the scripts built their chain client without the service's
 * hidden-service router, so on a zero-clearnet box they asked the system
 * resolver for the `.b32.i2p` / `.onion` names of the RPC nodes.
 *
 * Each script runs as a child process (tsx, the repo's smoke tsconfig) against
 * the test's own Postgres schema and a loopback chain that serves the honest
 * history.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const REPO = resolve(__dirname, '../../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const PRELOAD = resolve(__dirname, 'support/scriptPreload.mjs');
const FIRST = 1_000_001;
const LAST = 1_006_000;

/** The honest chain: block FIRST+k carries trader(k%50)'s order p<k> at (0, 0). */
function honestBlock(n: number): unknown {
	const g = n - 1_000_000;
	const transactions =
		n >= FIRST && n <= LAST
			? [
					{
						operations: [
							[
								'custom_json',
								{
									required_auths: [],
									required_posting_auths: [`trader${g % 50}`],
									id: 'morphit_order_v1',
									json: JSON.stringify({ permlink: `p${g}` })
								}
							]
						]
					}
				]
			: [];
	return {
		previous: (n - 1).toString(16).padStart(8, '0') + '0'.repeat(32),
		timestamp: '2026-10-01T00:00:00',
		witness: 'w',
		transaction_merkle_root: '0'.repeat(40),
		extensions: [],
		witness_signature: '',
		transactions,
		block_id: n.toString(16).padStart(8, '0') + '0'.repeat(32),
		signing_key: '',
		transaction_ids: transactions.map((_, i) => `${n}-${i}`.padEnd(40, '0'))
	};
}

function rpcAnswer(j: { id: unknown; method: string; params: unknown[] }): unknown {
	const [method, params] =
		j.method === 'call'
			? [String(j.params[1]), j.params[2] as unknown[]]
			: [String(j.method).replace(/^condenser_api\./, ''), j.params];
	if (method === 'get_block')
		return { jsonrpc: '2.0', id: j.id, result: honestBlock(Number(params[0])) };
	if (method === 'get_dynamic_global_properties') {
		return {
			jsonrpc: '2.0',
			id: j.id,
			result: {
				head_block_number: LAST + 10,
				last_irreversible_block_num: LAST + 10,
				time: '2026-10-01T00:00:00'
			}
		};
	}
	return { jsonrpc: '2.0', id: j.id, result: null };
}

const baseEnv = (fx: IntegrationFixture): NodeJS.ProcessEnv => ({
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	MORPHIT_INDEXER_DATABASE_URL: process.env.TEST_DATABASE_URL,
	MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
	MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
	MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
	MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
	MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
	MORPHIT_INDEXER_START_BLOCK: '1',
	MORPHIT_INDEXER_LOCAL_RPC_AUTODETECT: 'false',
	MORPHIT_RPC_HEALTH_STATE: join(mkdtempSync(join(tmpdir(), 'a1-rpc-')), 'health.json'),
	NODE_OPTIONS: `--import ${PRELOAD}`,
	TEST_SEARCH_PATH: fx.schema
});

/** Run a script as a child process. Asynchronous: the loopback chain is
 *  served from this process, so it must keep running meanwhile. */
function runScript(
	script: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	killAfterMs = 120_000
): Promise<{ status: number | null; out: string }> {
	return new Promise((done) => {
		const child = spawn(
			TSX,
			['--tsconfig', 'tsconfig.smoke.json', join('apps/indexer/scripts', script), ...args],
			{
				cwd: REPO,
				env,
				detached: true
			}
		);
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		// tsx runs the script in a grandchild: kill the whole group.
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				/* already gone */
			}
		}, killAfterMs);
		child.on('exit', (status) => {
			clearTimeout(timer);
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				/* already gone */
			}
			done({ status, out });
		});
	});
}

describe.skipIf(!INTEGRATION_ENABLED)('standalone chain scripts', () => {
	let fx: IntegrationFixture;
	let server: http.Server;
	let rpc: string;
	beforeAll(async () => {
		fx = await setupWithMigrations();
		server = http.createServer((req, res) => {
			let b = '';
			req.on('data', (c) => (b += c));
			req.on('end', () => {
				const j = JSON.parse(b);
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify(Array.isArray(j) ? j.map(rpcAnswer) : rpcAnswer(j)));
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(async () => {
		server?.closeAllConnections?.();
		server?.close();
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query('TRUNCATE ops, orders, accounts CASCADE');
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 SELECT 1000000 + g, 0, 0, '2026-10-01T00:00:00Z', (1000000 + g) || '-0', 'trader' || (g % 50),
			        'morphit_order_v1', jsonb_build_object('permlink', 'p' || g), 'applied'
			   FROM generate_series(1, 6000) g`
		);
	});

	const chainEnv = (): NodeJS.ProcessEnv => ({
		...baseEnv(fx),
		MORPHIT_INDEXER_RPC_ENDPOINTS: '',
		MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: '',
		MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: rpc
	});

	it('control: the honest history verifies (exit 0)', { timeout: 300_000 }, async () => {
		const r = await runScript('snapshot-verify-oplog.ts', ['--samples', '40'], chainEnv());
		expect(r.status, r.out).toBe(0);
	});

	it(
		'a forged op newer than the oldest 5,000 is caught: exit 3',
		{ timeout: 300_000 },
		async () => {
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES (1006500, 0, 0, '2026-10-01T00:00:00Z', 'forged', 'mallory', 'morphit_order_v1',
			         '{"permlink":"forged-listing"}', 'applied')`
			);
			const r = await runScript('snapshot-verify-oplog.ts', ['--samples', '40'], chainEnv());
			expect(r.status, r.out).toBe(3);
		}
	);

	it(
		'a forged orders row with no op behind it is caught: exit 3',
		{ timeout: 300_000 },
		async () => {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, fee_method)
			 SELECT 'mallory', 'free-' || g, 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live',
			        NOW(), NOW(), 'verified', 'blurt'
			   FROM generate_series(1, 3) g`
			);
			const r = await runScript('snapshot-verify-oplog.ts', ['--samples', '40'], chainEnv());
			expect(r.status, r.out).toBe(3);
		}
	);

	it(
		'on a zero-clearnet node the scripts reach the hidden RPC through i2pd, never the system resolver',
		{ timeout: 300_000 },
		async () => {
			const HIDDEN = `${'a'.repeat(52)}.b32.i2p`;
			// Stands in for i2pd's HTTP proxy: records the requests it is handed.
			const proxied: string[] = [];
			const proxy = http.createServer((req, res) => {
				proxied.push(`${req.method} ${req.url}`);
				res.writeHead(502);
				res.end();
			});
			proxy.on('connect', (req, socket) => {
				proxied.push(`CONNECT ${req.url}`);
				socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
			});
			await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
			try {
				for (const [script, args] of [
					['snapshot-verify-oplog.ts', ['--samples', '1']],
					['sync-profile.ts', ['--windows', '1', '--batch', '1']]
				] as const) {
					const dnsLog = join(mkdtempSync(join(tmpdir(), 'a1-dns-')), 'lookups.txt');
					proxied.length = 0;
					const r = await runScript(
						script,
						[...args],
						{
							...baseEnv(fx),
							MORPHIT_INDEXER_RPC_ENDPOINTS: '',
							MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: '',
							MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: `http://${HIDDEN}:8091`,
							MORPHIT_INDEXER_TOR_SOCKS: '127.0.0.1:1',
							MORPHIT_INDEXER_I2P_HTTP_PROXY: `127.0.0.1:${(proxy.address() as { port: number }).port}`,
							TEST_DNS_LOG: dnsLog
						},
						20_000
					);
					const lookups = existsSync(dnsLog)
						? readFileSync(dnsLog, 'utf8').split('\n').filter(Boolean)
						: [];
					expect(
						lookups.filter((h) => /\.(i2p|onion)$/i.test(h)),
						`${script}: hidden names sent to the system resolver\n${r.out.slice(-2000)}`
					).toEqual([]);
					expect(
						proxied.some((l) => l.includes(HIDDEN)),
						`${script}: the hidden RPC was never asked through i2pd\n${r.out.slice(-2000)}`
					).toBe(true);
				}
			} finally {
				proxy.closeAllConnections?.();
				proxy.close();
			}
		}
	);
});
