/**
 * ops-cli on a HIDDEN-ONLY node never leaves the box for the chain
 * (v1.18.0 deep-deep, H1).
 *
 * On a tor-only node (empty MORPHIT_INDEXER_RPC_ENDPOINTS in indexer.env) every
 * interactive launch fetched the latest version from git.agorise.net and read
 * the relay balance from six clearnet Blurt RPCs, and `register` /
 * `payment-method` signed and broadcast to those RPCs — the node's .onion and
 * its home IP in the same request.
 *
 * These drive the real functions against a stub of the node's own indexer,
 * with every fetch recorded: anything that is not that local indexer is
 * refused and counted. They assert what the functions return, what reached the
 * indexer (a correctly signed transaction), and that nothing else was asked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { PrivateKey, Signature, cryptoUtils } from '@beblurt/dblurt';
import { fetchLatestVersion } from '../src/lib/menuAnnotations.ts';
import { lookupBlurtAccount } from '../src/init/chainCheck.ts';
import {
	broadcastCustomJson,
	classifyChainError,
	printChainErrorHelp
} from '../src/commands/chainErrors.ts';
import { checkOutboundHttps, checkSystemTime } from '../src/init/systemCheck.ts';
import { readLocalRelease } from '../src/lib/hiddenOnly.ts';

const CHAIN_ID = Buffer.from(
	'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
	'hex'
);

interface Stub {
	readonly port: number;
	readonly seen: Array<{ method: string; url: string; body: unknown }>;
	broadcastReply: { status: number; body: unknown };
	close(): Promise<void>;
}

async function stubIndexer(): Promise<Stub> {
	const seen: Stub['seen'] = [];
	const stub = {
		seen,
		broadcastReply: { status: 200, body: { block_num: 777, trx_id: 'a'.repeat(40) } }
	} as Stub;
	const server: Server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
		req.on('end', () => {
			let body: unknown = null;
			try {
				body = raw === '' ? null : JSON.parse(raw);
			} catch {
				body = raw;
			}
			seen.push({ method: req.method ?? '', url: req.url ?? '', body });
			const send = (status: number, b: unknown): void => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(b));
			};
			if (req.url === '/v1/release') {
				return send(200, {
					version: '1.99.0',
					distribution: { ipfs_cid: 'bafybei' + 'a'.repeat(52) }
				});
			}
			if (req.url === '/v1/chain/condenser') {
				const m = (body as { method?: string }).method;
				if (m === 'get_accounts')
					return send(200, { result: [{ name: 'relayacct', balance: '12.500 BLURT' }] });
				if (m === 'get_dynamic_global_properties') {
					return send(200, {
						result: {
							head_block_number: 0x01020304,
							head_block_id: '01020304aabbccdd' + '0'.repeat(24),
							time: '2026-09-24T10:00:00'
						}
					});
				}
				return send(400, { status: 'error', code: 'bad_request', message: 'method not allowed' });
			}
			if (req.url === '/v1/broadcast')
				return send(stub.broadcastReply.status, stub.broadcastReply.body);
			return send(404, { status: 'error', code: 'not_found', message: 'no' });
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	(stub as { port: number }).port = (server.address() as AddressInfo).port;
	stub.close = () => new Promise<void>((r) => server.close(() => r()));
	return stub;
}

let root: string;
let stub: Stub;
const realFetch = globalThis.fetch;
/** Every URL any code asked fetch for, and the ones that were NOT the stub. */
let requested: string[];
let elsewhere: string[];

function writeIndexerEnv(clearnetPool: string): void {
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	writeFileSync(
		join(root, 'etc', 'morphit', 'indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=${clearnetPool}\n` +
			'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz2345.onion\n' +
			'MORPHIT_INDEXER_LISTEN_HOST=0.0.0.0\n' +
			`MORPHIT_INDEXER_LISTEN_PORT=${stub.port}\n`
	);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'morphit-hidden-chain-'));
	stub = await stubIndexer();
	process.env.MORPHIT_ENV_ROOT = root;
	requested = [];
	elsewhere = [];
	// Only the stub indexer answers. Everything else is refused as a network
	// failure (so no test can reach the real internet) and recorded.
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		requested.push(url);
		if (new URL(url).host === `127.0.0.1:${stub.port}`) return realFetch(input, init);
		elsewhere.push(url);
		throw new TypeError('fetch failed');
	}) as typeof fetch;
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	delete process.env.MORPHIT_ENV_ROOT;
	await stub.close();
	rmSync(root, { recursive: true, force: true });
});

describe('hidden-only node (empty clearnet RPC pool)', () => {
	beforeEach(() => writeIndexerEnv(''));

	it('menu "latest version" comes from the local indexer, not git.agorise.net', async () => {
		expect(await fetchLatestVersion(2000)).toBe('v1.99.0');
		expect(elsewhere).toEqual([]);
		expect(stub.seen.map((s) => s.url)).toEqual(['/v1/release']);
	});

	it('the upgrade seed step gets the on-chain CID from the local indexer (so the seed never asks clearnet)', async () => {
		expect(await readLocalRelease()).toEqual({ tag: 'v1.99.0', cid: 'bafybei' + 'a'.repeat(52) });
		expect(elsewhere).toEqual([]);
	});

	it('relay-balance lookup goes through the local indexer, never a clearnet RPC', async () => {
		const acct = await lookupBlurtAccount('relayacct');
		expect(acct?.balanceBlurt).toBe(12.5);
		expect(elsewhere).toEqual([]);
		expect(stub.seen).toHaveLength(1);
		expect(stub.seen[0]!.body).toEqual({ method: 'get_accounts', params: [['relayacct']] });
	});

	it('register/payment-method broadcast: signed locally, sent to the local /v1/broadcast only', async () => {
		const key = PrivateKey.fromSeed('morphit-hidden-only-test-key');
		const out = await broadcastCustomJson({
			account: 'relayacct',
			wif: key.toString(),
			opId: 'morphit_operator_register_v1',
			payload: { v: 1, tag: 'mynode', origin: 'http://x.onion' }
		});
		expect(out.trx_id).toBe('a'.repeat(40));
		expect(elsewhere).toEqual([]);
		const post = stub.seen.find((s) => s.url === '/v1/broadcast');
		expect(post).toBeDefined();
		const trx = (post!.body as { trx: Record<string, unknown> }).trx as {
			ref_block_num: number;
			ref_block_prefix: number;
			expiration: string;
			operations: Array<[string, Record<string, unknown>]>;
			extensions: unknown[];
			signatures: string[];
		};
		// Chain-head derived fields, from the indexer's properties.
		expect(trx.ref_block_num).toBe(0x0304);
		expect(trx.ref_block_prefix).toBe(Buffer.from('aabbccdd', 'hex').readUInt32LE(0));
		expect(trx.expiration).toBe('2026-09-24T10:01:00');
		expect(trx.operations).toEqual([
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['relayacct'],
					id: 'morphit_operator_register_v1',
					json: JSON.stringify({ v: 1, tag: 'mynode', origin: 'http://x.onion' })
				}
			]
		]);
		// The signature recovers to the signing key over the Blurt chain id.
		expect(trx.signatures).toHaveLength(1);
		const { signatures, ...unsigned } = trx;
		const digest = cryptoUtils.transactionDigest(unsigned as never, CHAIN_ID);
		expect(Signature.fromString(signatures[0]!).recover(digest).toString()).toBe(
			key.createPublic('BLT').toString()
		);
	});

	it('a chain rejection relayed by the indexer keeps its reason (diagnostics still classify it)', async () => {
		stub.broadcastReply = {
			status: 400,
			body: {
				status: 'error',
				code: 'bad_request',
				message: 'assert_exception: tag_reserved: morphit'
			}
		};
		const err = await broadcastCustomJson({
			account: 'relayacct',
			wif: PrivateKey.fromSeed('k2').toString(),
			opId: 'morphit_operator_register_v1',
			payload: { v: 1 }
		}).catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect(classifyChainError((err as Error).message)).toBe('tag_reserved');
		expect(elsewhere).toEqual([]);
	});

	it('indexer down: the broadcast fails as unreachable and NOTHING else is tried', async () => {
		await stub.close();
		stub.close = async () => undefined;
		const err = await broadcastCustomJson({
			account: 'relayacct',
			wif: PrivateKey.fromSeed('k3').toString(),
			opId: 'morphit_payment_method_addition_v1',
			payload: { v: 1 }
		}).catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect(classifyChainError((err as Error).message)).toBe('rpc_unreachable');
		// Only local indexer addresses were ever asked.
		for (const u of requested)
			expect(new URL(u).hostname).toMatch(/^(127\.0\.0\.1|172\.1[78]\.0\.1)$/);
		// And the operator is not told to go and reach a clearnet host.
		const lines: string[] = [];
		printChainErrorHelp(
			(err as Error).message,
			{ opLabel: 'x', account: 'relayacct', tag: null, keyFile: '/k', nameEnvVar: 'N' },
			(l) => lines.push(l)
		);
		expect(lines.join('\n')).not.toMatch(/https?:\/\/(?!127\.)/);
	});

	it('re-running init: the outbound-HTTPS and clock checks do not reach clearnet', async () => {
		const a = await checkOutboundHttps();
		const b = await checkSystemTime();
		expect(a.status).toBe('ok');
		expect(b.status).toBe('ok');
		expect(requested).toEqual([]);
	});
});

describe('clearnet node (control)', () => {
	beforeEach(() => writeIndexerEnv('https://rpc.example.invalid'));

	it('keeps its clearnet behaviour: the version check still asks the release host', async () => {
		expect(await fetchLatestVersion(2000)).toBeNull();
		expect(
			elsewhere.some(
				(u) => new URL(u).hostname === (process.env.MORPHIT_RELEASE_HOST ?? 'git.agorise.net')
			)
		).toBe(true);
		expect(stub.seen).toEqual([]);
	});
});
