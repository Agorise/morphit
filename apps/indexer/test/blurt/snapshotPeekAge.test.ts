/**
 * snapshot-bootstrap says how old the snapshot it found is, from the chain's
 * own clock, and `--peek` says which snapshot a run would restore without
 * downloading or changing anything (fast-sync shows that before it asks).
 *
 * Review, 2026-10-29: fast-sync never said how old the snapshot was, and told
 * operators "one is published daily" — anchoring is a manual step (see
 * ops/snapshot-autopublish.sh), so the newest snapshot can be weeks old, and
 * the catch-up after it correspondingly long.
 *
 * Runs the real script (tsx) against two local JSON-RPC stubs that agree on a
 * genuinely signed snapshot op; no database is touched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEXER_SNAPSHOT_OP_ID } from '../../src/blurt/indexerSnapshotOp';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL = PrivateKey.fromSeed('snapshot-peek-official-posting');
const OFFICIAL_PUB = OFFICIAL.createPublic().toString();
const HEAD = 9_000_000;
const HEAD_TIME = '2026-09-24T00:00:00';
const work = mkdtempSync(join(tmpdir(), 'snap-peek-'));
const servers: http.Server[] = [];
afterAll(async () => {
	await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
	rmSync(work, { recursive: true, force: true });
});

/** A chain where @morphit's newest snapshot op (in block `opBlock`) names
 *  `snapBlock`, whose own block is stamped `snapTime`. */
function chainView(snapBlock: number, snapTime: string, opBlock: number) {
	const payload = {
		ipfs_cid: 'bafy' + 'a'.repeat(55),
		sha256: 'ab'.repeat(32),
		chain_id: CHAIN_ID,
		schema_version: 70,
		last_applied_block: snapBlock,
		size_bytes: 600_000,
		indexer_version: '1.21.17'
	};
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: INDEXER_SNAPSHOT_OP_ID,
			json: JSON.stringify(payload)
		}
	];
	const tx = cryptoUtils.signTransaction(
		{
			ref_block_num: 1234,
			ref_block_prefix: 5678,
			expiration: '2026-09-24T00:01:00',
			operations: [op],
			extensions: []
		} as never,
		[OFFICIAL],
		Buffer.from(CHAIN_ID, 'hex')
	) as unknown as Record<string, unknown>;
	const trxId = cryptoUtils.generateTrxId(tx as never);
	return {
		history: [
			[
				42,
				{
					trx_id: trxId,
					block: opBlock,
					trx_in_block: 0,
					op_in_trx: 0,
					virtual_op: 0,
					timestamp: HEAD_TIME,
					op
				}
			]
		],
		blocks: {
			[opBlock]: {
				block_id: `b${opBlock}`,
				previous: 'p',
				timestamp: HEAD_TIME,
				witness: 'w',
				transactions: [tx],
				transaction_ids: [trxId]
			},
			[snapBlock]: {
				block_id: `b${snapBlock}`,
				previous: 'p',
				timestamp: snapTime,
				witness: 'w',
				transactions: [],
				transaction_ids: []
			}
		} as Record<number, unknown>
	};
}

async function chainStub(
	host: string,
	view: ReturnType<typeof chainView>
): Promise<{ url: string; asked: string[] }> {
	const asked: string[] = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const j = JSON.parse(body) as { id?: number; method?: string; params?: unknown[] };
			asked.push(j.method ?? '');
			let result: unknown = null;
			if (j.method === 'condenser_api.get_account_history') result = view.history;
			else if (j.method === 'condenser_api.get_block')
				result = view.blocks[Number((j.params ?? [])[0])] ?? null;
			else if (j.method === 'condenser_api.get_dynamic_global_properties')
				result = {
					head_block_number: HEAD,
					last_irreversible_block_num: HEAD,
					time: HEAD_TIME
				};
			res.writeHead(200);
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }));
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as { port: number }).port;
	return { url: `http://${host}:${port}`, asked };
}

function bootstrap(
	args: string[],
	rpcs: string[],
	extra: Record<string, string> = {},
	o: { interruptWhen?: (said: string) => boolean } = {}
): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((res) => {
		const p = spawn(
			TSX,
			[
				'--tsconfig',
				join(REPO, 'tsconfig.smoke.json'),
				join(REPO, 'apps/indexer/scripts/snapshot-bootstrap.ts'),
				...args
			],
			{
				cwd: REPO,
				env: {
					...process.env,
					MORPHIT_INDEXER_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never-used',
					MORPHIT_INDEXER_CHAIN_ID: CHAIN_ID,
					MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://node.example.org',
					MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: OFFICIAL_PUB,
					MORPHIT_INDEXER_RPC_ENDPOINTS: '',
					MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: '',
					MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: rpcs.join(','),
					MORPHIT_RPC_HEALTH_STATE: join(work, 'health.json'),
					MORPHIT_SNAPSHOT_NO_KUBO: '1',
					MORPHIT_IPFS_GATEWAYS: 'http://127.0.0.1:1',
					...extra
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: o.interruptWhen !== undefined
			}
		);
		let out = '';
		let err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		if (o.interruptWhen !== undefined) {
			const t = setInterval(() => {
				if (!o.interruptWhen!(out + err)) return;
				clearInterval(t);
				// Ctrl+C, as a terminal sends it: to the whole process group.
				process.kill(-p.pid!, 'SIGINT');
			}, 20);
			p.on('close', () => clearInterval(t));
		}
		p.on('close', (code) => res({ code, out, err }));
	});
}

describe('the snapshot’s age, from the chain', () => {
	it('--peek: which snapshot, how old, how much to catch up — nothing downloaded', async () => {
		// Stamped 3 days before the head.
		const view = chainView(8_913_600, '2026-09-21T00:00:00', 8_999_990);
		const a = await chainStub('127.0.0.1', view);
		const b = await chainStub('localhost', view);
		const r = await bootstrap(['--from-chain', '--peek'], [a.url, b.url]);
		expect(r.code, r.err).toBe(0);
		const peek = JSON.parse(r.out.trim().split('\n').at(-1)!) as {
			block: number;
			indexerVersion: string;
			lines: string[];
		};
		expect(peek.block).toBe(8_913_600);
		expect(peek.indexerVersion).toBe('1.21.17');
		const text = peek.lines.join('\n');
		expect(text).toContain('This snapshot is from block 8,913,600, about 3 days old');
		expect(text).toContain('catches up 86,400 blocks (about 3 days of chain history)');
		expect(text).toMatch(/more than 2 days old/);
		expect(text).toMatch(/anchored on the chain by hand, not on a schedule/);
		expect(r.err).not.toMatch(/fetching from/);
	}, 60_000);

	it('a recent snapshot: its age, and no warning', async () => {
		const view = chainView(8_995_200, '2026-09-23T20:00:00', 8_999_991);
		const a = await chainStub('127.0.0.1', view);
		const b = await chainStub('localhost', view);
		const r = await bootstrap(['--from-chain', '--peek'], [a.url, b.url]);
		expect(r.code, r.err).toBe(0);
		const text = (JSON.parse(r.out.trim().split('\n').at(-1)!) as { lines: string[] }).lines.join(
			'\n'
		);
		expect(text).toContain('about 4 hours old');
		expect(text).not.toMatch(/more than 2 days old/);
	}, 60_000);

	it('a real run says it right after finding the snapshot — unless its caller already did', async () => {
		const view = chainView(8_913_600, '2026-09-21T00:00:00', 8_999_992);
		const a = await chainStub('127.0.0.1', view);
		const b = await chainStub('localhost', view);
		const r = await bootstrap(['--from-chain', '--i-trust-signer'], [a.url, b.url]);
		expect(r.code).not.toBe(0); // no source can serve it here
		expect(r.err).toContain('This snapshot is from block 8,913,600, about 3 days old');
		// No false advice: the start block is already Morphit's first block.
		expect(r.err).not.toMatch(/START_BLOCK|genesis|published daily/);
		const quiet = await bootstrap(['--from-chain', '--i-trust-signer'], [a.url, b.url], {
			MORPHIT_SNAPSHOT_AGE_SHOWN: '1'
		});
		expect(quiet.err).toContain('found: block 8,913,600');
		expect(quiet.err).not.toContain('This snapshot is from block');
	}, 90_000);
});

/** Every file under `dir`, with its size. */
function filesUnder(dir: string): Array<{ path: string; size: number }> {
	const out: Array<{ path: string; size: number }> = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...filesUnder(p));
		else if (e.isFile()) out.push({ path: p, size: statSync(p).size });
	}
	return out;
}

/** A snapshot file like snapshot-export makes (manifest first, then the dump),
 *  or with the dump first. */
function snapshotFile(name: string, dumpBytes: number, dumpFirst = false): string {
	const d = mkdtempSync(join(work, 'make-'));
	writeFileSync(
		join(d, 'manifest.json'),
		JSON.stringify({
			snapshotFormatVersion: 1,
			chainId: CHAIN_ID,
			schemaVersion: 70,
			lastAppliedBlock: 8_913_600,
			pgMajor: 16,
			createdAt: '2026-09-21T00:00:00Z',
			sourceLabel: 'alice-box',
			indexerVersion: '1.21.17'
		})
	);
	// Random bytes: an archive that does not shrink, like a real gzip'd dump.
	writeFileSync(join(d, 'indexer.sql.gz'), randomBytes(dumpBytes));
	const file = join(work, name);
	const members = dumpFirst
		? ['indexer.sql.gz', 'manifest.json']
		: ['manifest.json', 'indexer.sql.gz'];
	expect(spawnSync('tar', ['-czf', file, '-C', d, ...members]).status).toBe(0);
	rmSync(d, { recursive: true, force: true });
	return file;
}

/** A gateway/mirror stand-in that records every request it gets. */
async function sourceStub(): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? '');
		res.writeHead(404);
		res.end();
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits };
}

describe('--peek writes and downloads nothing (review, 2026-10-29)', () => {
	it('a hidden-only node, from the chain: read through its own RPC nodes, no source asked, nothing written', async () => {
		const view = chainView(8_913_600, '2026-09-21T00:00:00', 8_999_993);
		const a = await chainStub('127.0.0.1', view);
		const b = await chainStub('localhost', view);
		const gateway = await sourceStub();
		const tmp = mkdtempSync(join(work, 'tmp-'));
		// No clearnet RPC node (the stand-ins are this box's own): hidden-only,
		// clearnet refused. Every source a real run would try is the stand-in.
		const r = await bootstrap(['--from-chain', '--peek'], [a.url, b.url], {
			MORPHIT_INDEXER_RPC_ENDPOINTS: '',
			MORPHIT_IPFS_GATEWAYS: gateway.url,
			MORPHIT_LOCAL_IPFS_GATEWAY: gateway.url,
			TMPDIR: tmp
		});
		expect(r.code, r.err).toBe(0);
		expect(r.out + r.err).toMatch(/clearnet_policy=refuse/);
		expect(JSON.parse(r.out.trim().split('\n').at(-1)!).block).toBe(8_913_600);
		expect(gateway.hits).toEqual([]);
		expect(
			[...a.asked, ...b.asked].every((m) =>
				/get_account_history|get_block|get_dynamic_global_properties/.test(m)
			)
		).toBe(true);
		expect(filesUnder(tmp).filter((f) => /morphit/.test(f.path))).toEqual([]);
	}, 60_000);

	it('a snapshot file: its block, and the dump is never written anywhere', async () => {
		const file = snapshotFile('snap.tar.gz', 8 * 1024 * 1024);
		const tmp = mkdtempSync(join(work, 'tmp-'));
		const r = await bootstrap([file, '--peek'], ['http://127.0.0.1:1'], { TMPDIR: tmp });
		expect(r.code, r.err).toBe(0);
		const peek = JSON.parse(r.out.trim().split('\n').at(-1)!) as { block: number; lines: string[] };
		expect(peek.block).toBe(8_913_600);
		expect(peek.lines.join(' ')).toContain('This snapshot file is from block 8,913,600');
		// Nothing anywhere near the dump's size was written.
		expect(filesUnder(tmp).filter((f) => f.size > 1024 * 1024)).toEqual([]);
		// A dump stored before the manifest is read past, not stored either.
		const first = snapshotFile('dumpfirst.tar.gz', 8 * 1024 * 1024, true);
		const r2 = await bootstrap([first, '--peek'], ['http://127.0.0.1:1'], { TMPDIR: tmp });
		expect(r2.code, r2.err).toBe(0);
		expect(filesUnder(tmp).filter((f) => f.size > 1024 * 1024)).toEqual([]);
	}, 60_000);

	it('Ctrl+C while it reads a large file: stops, says nothing was changed, leaves nothing behind', async () => {
		const file = snapshotFile('big.tar.gz', 200 * 1024 * 1024, true);
		const tmp = mkdtempSync(join(work, 'tmp-'));
		let ready = 0;
		const r = await bootstrap(
			[file, '--peek'],
			['http://127.0.0.1:1'],
			{ TMPDIR: tmp },
			{
				// Once it is reading (its routing line is out), and a moment more.
				interruptWhen: (said) => {
					if (!said.includes('hidden-dispatcher')) return false;
					if (ready === 0) ready = Date.now();
					return Date.now() - ready > 300;
				}
			}
		);
		expect(r.code).toBe(130);
		expect(r.err).toContain('stopped. Nothing was changed.');
		expect(filesUnder(tmp).filter((f) => f.size > 1024 * 1024)).toEqual([]);
	}, 120_000);
});

describe('what the run restores is what was shown', () => {
	it('another snapshot than the one shown: refused before anything is fetched', async () => {
		const view = chainView(8_913_600, '2026-09-21T00:00:00', 8_999_996);
		const a = await chainStub('127.0.0.1', view);
		const b = await chainStub('localhost', view);
		const r = await bootstrap(
			['--from-chain', '--i-trust-signer', '--expect-block', '8900000'],
			[a.url, b.url]
		);
		expect(r.code).toBe(1);
		expect(r.err).toContain('the snapshot is now at block 8,913,600, not block 8,900,000');
		expect(r.err).toContain('Nothing was downloaded or changed');
		expect(r.err).not.toMatch(/fetching from/);
		// The one shown: on to the download (which no source here can serve).
		const same = await bootstrap(
			['--from-chain', '--i-trust-signer', '--expect-block', '8913600'],
			[a.url, b.url]
		);
		expect(same.err).not.toContain('the snapshot is now at block');
	}, 90_000);
});
