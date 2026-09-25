/**
 * v1.18.0 deep-deep (rv2-4) — the persisted rpc directory is re-proved against
 * the chain at boot before any of its endpoints join the live pool.
 *
 * The boot step used to merge `rpc_directory.endpoints` as stored. A snapshot
 * restore brings that row over from another database, so whatever URLs it held
 * became permanent members of this node's RPC pool, unchecked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { BlurtClient } from '../../src/blurt/client';
import { reloadVerifiedRpcDirectory } from '../../src/indexer/rpcDirectoryReload';
import { RPC_DIRECTORY_OP_ID } from '../../src/blurt/rpcDirectoryOp';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL = PrivateKey.fromSeed('rpc-dir-reload-official');
const OTHER = PrivateKey.fromSeed('rpc-dir-reload-someone-else');
const CONFIG = {
	officialAccountName: 'morphit',
	officialPostingPubkey: OFFICIAL.createPublic().toString(),
	chainId: CHAIN_ID
};

const EVIL = [
	'http://' + 'e'.repeat(56) + '.onion:8091',
	'http://' + 'f'.repeat(52) + '.b32.i2p:8091'
];
const GOOD = {
	onion: 'http://' + 'g'.repeat(56) + '.onion:8091',
	i2p: 'http://' + 'h'.repeat(52) + '.b32.i2p:8091',
	name: 'Good'
};

function blockWith(key: typeof OFFICIAL | null, nodes: unknown[]): unknown {
	const txs: unknown[] = [];
	if (key !== null) {
		const op = [
			'custom_json',
			{
				required_auths: [],
				required_posting_auths: ['morphit'],
				id: RPC_DIRECTORY_OP_ID,
				json: JSON.stringify({ v: 1, ts: '2026-09-01T00:00:00Z', nodes })
			}
		];
		txs.push(
			cryptoUtils.signTransaction(
				{
					ref_block_num: 1,
					ref_block_prefix: 2,
					expiration: '2026-09-01T00:01:00',
					operations: [op],
					extensions: []
				} as never,
				[key],
				Buffer.from(CHAIN_ID, 'hex')
			)
		);
	}
	return {
		block_id: 'blk100',
		previous: 'p',
		timestamp: '2026-09-01T00:00:00',
		witness: 'w',
		transactions: txs,
		transaction_ids: []
	};
}

interface Srv {
	url: string;
	close(): Promise<void>;
}
async function chain(host: string, block: unknown): Promise<Srv> {
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const j = JSON.parse(body) as { id?: number; method?: string };
			const result = j.method === 'condenser_api.get_block' ? block : null;
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }));
		});
	});
	await new Promise<void>((r) => server.listen(0, host, () => r()));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://${host}:${port}`,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections?.();
				server.close(() => r());
			})
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('boot reload of the rpc directory (rv2-4)', () => {
	let fx: IntegrationFixture;
	let servers: Srv[] = [];
	beforeAll(async () => {
		process.env.MORPHIT_RPC_HEALTH_STATE = join(
			mkdtempSync(join(tmpdir(), 'rpcdir-')),
			'health.json'
		);
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		await fx.db.query('DELETE FROM rpc_directory');
		// A restored row: attacker URLs, pointing at block 100.
		await fx.db.query(
			`INSERT INTO rpc_directory (id, endpoints, node_count, published_ts, block_num) VALUES (1, $1, 1, now(), 100)`,
			[EVIL]
		);
	});
	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		servers = [];
	});
	const clientFor = async (block: unknown): Promise<BlurtClient> => {
		servers = [await chain('127.0.0.2', block), await chain('127.0.0.3', block)];
		return new BlurtClient({
			localRpcEndpoints: servers.map((s) => s.url),
			blurtRpcEndpoints: []
		} as never);
	};
	const poolUrls = (b: BlurtClient): string[] => b.endpointSnapshot().map((e) => e.url);

	it('a stored row the chain does not back is not merged, and is dropped', async () => {
		const blurt = await clientFor(blockWith(null, []));
		await reloadVerifiedRpcDirectory(fx.db, blurt, CONFIG);
		for (const u of EVIL) expect(poolUrls(blurt)).not.toContain(u);
		expect((await fx.db.query('SELECT count(*)::int AS n FROM rpc_directory')).rows[0]!.n).toBe(0);
	});

	it('a directory op in that block signed by a key other than the pinned one is not merged', async () => {
		const blurt = await clientFor(blockWith(OTHER, [{ onion: EVIL[0] }]));
		await reloadVerifiedRpcDirectory(fx.db, blurt, CONFIG);
		for (const u of EVIL) expect(poolUrls(blurt)).not.toContain(u);
	});

	it('the signed op in that block is what gets merged — not the stored row', async () => {
		const blurt = await clientFor(blockWith(OFFICIAL, [GOOD]));
		await reloadVerifiedRpcDirectory(fx.db, blurt, CONFIG);
		expect(poolUrls(blurt)).toContain(GOOD.onion);
		expect(poolUrls(blurt)).toContain(GOOD.i2p);
		for (const u of EVIL) expect(poolUrls(blurt)).not.toContain(u);
	});
});
