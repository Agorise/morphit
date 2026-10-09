/**
 * Test helpers: a signed `morphit_release_v1` op as the chain would hold it,
 * and a stand-in for this node's own indexer that answers `/v1/release`,
 * `/v1/instance`, `/v1/instances` and the `/v1/chain/condenser` relay.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';

export const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
export const OFFICIAL = PrivateKey.fromSeed('ops-cli-release-anchor-official');
export const OFFICIAL_PUB = OFFICIAL.createPublic().toString();
export const OTHER = PrivateKey.fromSeed('ops-cli-release-anchor-someone-else');

export interface ChainFixture {
	history: unknown[];
	blocks: Record<number, unknown>;
}

/** A signed release op for `version` with `distribution`, in block `blockNum`. */
export function signedRelease(
	version: string,
	distribution: Record<string, unknown>,
	opts: { key?: PrivateKey; blockNum?: number; seq?: number } = {}
): ChainFixture {
	const blockNum = opts.blockNum ?? 70_000_000;
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: 'morphit_release_v1',
			json: JSON.stringify({ version, hash_manifest: {}, distribution })
		}
	];
	const tx = cryptoUtils.signTransaction(
		{
			ref_block_num: 1234,
			ref_block_prefix: 5678,
			expiration: '2026-10-01T00:01:00',
			operations: [op],
			extensions: []
		} as never,
		[opts.key ?? OFFICIAL],
		Buffer.from(CHAIN_ID, 'hex')
	) as unknown as Record<string, unknown>;
	const trxId = cryptoUtils.generateTrxId(tx as never);
	return {
		history: [
			[
				opts.seq ?? 42,
				{ trx_id: trxId, block: blockNum, trx_in_block: 0, op_in_trx: 0, virtual_op: 0, op }
			]
		],
		blocks: {
			[blockNum]: { block_id: `b${blockNum}`, transactions: [tx], transaction_ids: [trxId] }
		}
	};
}

export function mergeFixtures(...fs: ChainFixture[]): ChainFixture {
	return {
		history: fs.flatMap((f) => f.history),
		blocks: Object.assign({}, ...fs.map((f) => f.blocks))
	};
}

/** A condenser reader over a fixture. */
export function fixtureReader(f: ChainFixture) {
	return async (method: string, params: readonly unknown[]): Promise<unknown> => {
		if (method === 'get_account_history') return f.history;
		if (method === 'get_block') return f.blocks[Number(params[0])] ?? null;
		throw new Error(`unexpected ${method}`);
	};
}

export interface StubIndexer {
	readonly base: string;
	readonly paths: string[];
	/** How many times the condenser relay was asked for account history. */
	historyCalls(): number;
	close(): Promise<void>;
}

/** This node's indexer, answering from `release` and the chain fixture. */
export async function stubIndexer(opts: {
	release?: unknown;
	chain?: ChainFixture;
	instances?: unknown;
	/** The history answers in the order they are given, the last repeating:
	 *  a node behind the chain answers without the newest ops. Blocks still
	 *  come from `chain`. */
	historyAnswers?: unknown[][];
}): Promise<StubIndexer> {
	const paths: string[] = [];
	let historyCalls = 0;
	const server: Server = createServer((req, res) => {
		paths.push(`${req.method} ${req.url}`);
		const send = (status: number, body: unknown): void => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/v1/instance')
			return send(200, { clearnet_eliminated: true, clearnet_eliminated_missing: [] });
		if (req.url === '/v1/release') return opts.release ? send(200, opts.release) : send(404, {});
		if (req.url === '/v1/instances') return send(200, opts.instances ?? { instances: [] });
		if (req.url === '/v1/chain/condenser' && req.method === 'POST') {
			let body = '';
			req.on('data', (d) => (body += d));
			req.on('end', () => {
				const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
				const f = opts.chain ?? { history: [], blocks: {} };
				if (method === 'get_account_history') {
					const a = opts.historyAnswers;
					const n = historyCalls++;
					return send(200, {
						result: a !== undefined && a.length > 0 ? a[Math.min(n, a.length - 1)] : f.history
					});
				}
				if (method === 'get_block')
					return send(200, { result: f.blocks[Number(params[0])] ?? null });
				send(400, { message: 'method not allowed' });
			});
			return;
		}
		send(404, { error: 'not_found' });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		paths,
		historyCalls: () => historyCalls,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

export interface StubNode {
	readonly url: string;
	historyCalls(): number;
	close(): Promise<void>;
}

/** A Blurt RPC node (JSON-RPC over HTTP) answering condenser_api reads from a fixture. */
export async function stubNode(chain: ChainFixture): Promise<StubNode> {
	let historyCalls = 0;
	const server: Server = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const { id, method, params } = JSON.parse(body) as {
				id: number;
				method: string;
				params: unknown[];
			};
			const reply = (result: unknown): void => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
			};
			if (method === 'condenser_api.get_account_history') {
				historyCalls++;
				return reply(chain.history);
			}
			if (method === 'condenser_api.get_block')
				return reply(chain.blocks[Number(params[0])] ?? null);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { message: `no ${method}` } }));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		historyCalls: () => historyCalls,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}
