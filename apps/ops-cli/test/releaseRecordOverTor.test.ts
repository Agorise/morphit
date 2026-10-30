/**
 * @morphit's signed release record, read over Tor/I2P (v1.21.18).
 *
 * WHAT WENT WRONG (morphitlat, hidden-only, v1.21.16). The upgrade asked this
 * node's own indexer for the newest 1000 entries of @morphit's history in one
 * read. The indexer relays it over Tor/I2P, where 10 entries (23,646 bytes)
 * took 33.7 s and 100 never came within 240 s. Every upgrade stopped with
 * "@morphit's signed record could not be read".
 *
 * NOW. The block this node's indexer names for the op (`/v1/release`
 * source_block_num / source_trx_id) is checked first — one small read — and
 * the history is read in small pages, each with time for a slow answer, walking
 * back until the record is found. The op must still be signed by the pinned
 * posting key, checked as before.
 *
 * The simulated indexer below behaves like that relay: it answers after 3 s
 * per KB of its answer, and never answers a page of more than 50 entries.
 * Its entries are as large as @morphit's (about 3.9 KB), and only every other
 * history position is an entry (the other is the chain's fee for the op, which
 * the answer leaves out), as on the real chain. Time is simulated: the test
 * advances the clock and lets the sockets run.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	CHAIN_ID,
	OFFICIAL_PUB,
	OTHER,
	signedRelease,
	type ChainFixture
} from './helpers/releaseChain.ts';
import {
	historyPage as page,
	slowIndexer as slowTorIndexer,
	underSimulatedTime,
	useSimulatedTimers
} from './helpers/slowTorIndexer.ts';

let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { tryResolveHiddenUpgrade } = await import('../src/init/hiddenUpgradeResolve.ts');
const { runUpgrade } = await import('../src/commands/upgrade.ts');
const { readSignedReleaseAnchor } = await import('../src/lib/releaseAnchor.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-tor-record-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Room in an op's JSON so its history entry is about as large as @morphit's
 *  real ones (a release op is 3-4 KB). */
const PAD = 'x'.repeat(3_600);
const CID = `bafy${'a'.repeat(55)}`;
const VERSION = '1.21.18';

interface PagedChain extends ChainFixture {
	/** Newest history position. */
	readonly top: number;
}

/**
 * @morphit's history: positions 0..top, an entry at every odd position (the
 * even ones are the chain's fee for the op, which the condenser answer leaves
 * out), filler ops everywhere except where `records` puts a signed release op.
 */
function pagedChain(top: number, records: Array<{ seq: number; f: ChainFixture }>): PagedChain {
	const history: unknown[] = [];
	const blocks: Record<number, unknown> = {};
	for (let seq = 1; seq <= top; seq += 2) {
		const rec = records.find((r) => r.seq === seq);
		if (rec) {
			const e = rec.f.history[0] as [number, Record<string, unknown>];
			history.push([seq, e[1]]);
			Object.assign(blocks, rec.f.blocks);
			continue;
		}
		history.push([
			seq,
			{
				trx_id: randomBytes(20).toString('hex'),
				block: 64_000_000 + seq,
				trx_in_block: 0,
				op_in_trx: 0,
				virtual_op: 0,
				op: [
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['morphit'],
						id: 'community',
						json: JSON.stringify({ note: PAD })
					}
				]
			}
		]);
	}
	return { top, history, blocks };
}

/** A signed release op for VERSION in `blockNum`, its entry padded. */
function record(
	sourceSha: string,
	opts: { key?: typeof OTHER; blockNum: number; version?: string }
): ChainFixture {
	return signedRelease(
		opts.version ?? VERSION,
		{ source_sha256: sourceSha, ipfs_cid: CID, gpg_fingerprint: 'A'.repeat(40), note: PAD },
		{ ...(opts.key ? { key: opts.key } : {}), blockNum: opts.blockNum }
	);
}

const historyPage = (chain: PagedChain, params: readonly unknown[]): unknown[] =>
	page(
		{ top: chain.top, entries: chain.history as Array<[number, unknown]>, blocks: chain.blocks },
		params
	);

interface ReadLog {
	history: Array<readonly unknown[]>;
	blocks: number[];
}

/** A condenser reader over a paged chain (the unit tests). */
function pagedReader(chain: PagedChain, log: ReadLog) {
	return async (method: string, params: readonly unknown[]): Promise<unknown> => {
		if (method === 'get_account_history') {
			log.history.push(params);
			return historyPage(chain, params);
		}
		if (method === 'get_block') {
			log.blocks.push(Number(params[0]));
			return chain.blocks[Number(params[0])] ?? null;
		}
		throw new Error(`unexpected ${method}`);
	};
}

const args = {
	tag: `v${VERSION}`,
	signer: 'morphit',
	pinnedPubkey: OFFICIAL_PUB,
	chainId: CHAIN_ID
};

describe('the release record read in small pages', () => {
	// 10 positions a page: page 1 = 89..99, page 2 = 78..88, page 3 = 67..77.
	const paging = { pageSize: 10, maxPages: 10 };

	it('finds a record on page 3, reading no further', async () => {
		const real = record('a'.repeat(64), { blockNum: 70_000_001 });
		const chain = pagedChain(99, [{ seq: 71, f: real }]);
		const log: ReadLog = { history: [], blocks: [] };
		const r = await readSignedReleaseAnchor(pagedReader(chain, log), { ...args, ...paging });
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
		expect(log.history.length).toBe(3);
		// Each page starts just below the one before: nothing skipped.
		expect(log.history.map((p) => p[1])).toEqual([-1, 88, 78]);
	});

	it('a record deeper than the pages reach is "not listed", as before', async () => {
		const real = record('a'.repeat(64), { blockNum: 70_000_001 });
		const chain = pagedChain(999, [{ seq: 101, f: real }]);
		const log: ReadLog = { history: [], blocks: [] };
		const r = await readSignedReleaseAnchor(pagedReader(chain, log), { ...args, ...paging });
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ notListed: true });
		expect('unreadable' in r && r.unreadable).toBeFalsy();
		expect('invalid' in r && r.invalid).toBeFalsy();
		expect(log.history.length).toBe(10);
		expect(log.blocks).toEqual([]);
	});

	it('a forged record on an earlier page is passed over for the genuine one', async () => {
		const forged = record('d'.repeat(64), { key: OTHER, blockNum: 70_000_002 });
		const real = record('a'.repeat(64), { blockNum: 70_000_001 });
		const chain = pagedChain(99, [
			{ seq: 95, f: forged },
			{ seq: 71, f: real }
		]);
		const log: ReadLog = { history: [], blocks: [] };
		const r = await readSignedReleaseAnchor(pagedReader(chain, log), { ...args, ...paging });
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
	});

	it('a forged record and nothing genuine is still a fault, never "not listed"', async () => {
		const forged = record('d'.repeat(64), { key: OTHER, blockNum: 70_000_002 });
		const chain = pagedChain(99, [{ seq: 95, f: forged }]);
		const r = await readSignedReleaseAnchor(pagedReader(chain, { history: [], blocks: [] }), {
			...args,
			...paging
		});
		expect(r.ok).toBe(false);
		expect('notListed' in r && r.notListed).toBeFalsy();
	});

	it("the block this node's indexer names is one read, and no history is read", async () => {
		const real = record('a'.repeat(64), { blockNum: 70_000_001 });
		const chain = pagedChain(999, [{ seq: 101, f: real }]);
		const trxId = (real.history[0] as [number, { trx_id: string }])[1].trx_id;
		const log: ReadLog = { history: [], blocks: [] };
		const r = await readSignedReleaseAnchor(pagedReader(chain, log), {
			...args,
			...paging,
			hint: { blockNum: 70_000_001, trxId }
		});
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
		expect(log.history.length).toBe(0);
		expect(log.blocks).toEqual([70_000_001]);
	});

	it('a hint to a forged block proves nothing: the history decides', async () => {
		const forged = record('d'.repeat(64), { key: OTHER, blockNum: 70_000_002 });
		const real = record('a'.repeat(64), { blockNum: 70_000_001 });
		const chain = pagedChain(99, [{ seq: 71, f: real }]);
		Object.assign(chain.blocks, forged.blocks);
		const trxId = (forged.history[0] as [number, { trx_id: string }])[1].trx_id;
		const r = await readSignedReleaseAnchor(pagedReader(chain, { history: [], blocks: [] }), {
			...args,
			...paging,
			hint: { blockNum: 70_000_002, trxId }
		});
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
	});
});

// ─── Through the simulated hidden-only indexer (helpers/slowTorIndexer.ts) ──

/** This node's indexer, slow as Tor/I2P, over `chain`. */
const slowIndexer = (o: { chain: PagedChain; release: unknown; instances: unknown }) =>
	slowTorIndexer({
		history: {
			top: o.chain.top,
			entries: o.chain.history as Array<[number, unknown]>,
			blocks: o.chain.blocks
		},
		release: o.release,
		instances: o.instances
	});

const trustListener = () => ({ kind: 'verified' as const, how: 'override' as const });
const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };

/** A tarball for VERSION, the chain whose genuine record names it (deep in the
 *  history: page 3), and the /v1/release that names where the op is. */
function scenario() {
	peerBytes = Buffer.from(`release ${VERSION} ${Math.random()}`);
	const real = record(sha(peerBytes), { blockNum: 70_000_001 });
	const trxId = (real.history[0] as [number, { trx_id: string }])[1].trx_id;
	// An older release record nearer the top must not be taken for this one.
	const older = record('e'.repeat(64), { blockNum: 69_000_000, version: '1.21.17' });
	const chain = pagedChain(1_201, [
		{ seq: 1_199, f: older },
		{ seq: 1_175, f: real }
	]);
	return { chain, trxId };
}

describe('a hidden-only upgrade reads the record through a slow Tor/I2P indexer', () => {
	let envFile = '';
	beforeEach(() => {
		useSimulatedTimers();
		envFile = join(mkdtempSync(join(scratch, 'env-')), 'indexer.env');
		writeFileSync(envFile, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
	});
	afterEach(() => vi.useRealTimers());

	const resolve = (base: string) =>
		tryResolveHiddenUpgrade({
			configEnvPaths: [envFile],
			bases: [base],
			verifyListener: trustListener,
			postingPubkey: OFFICIAL_PUB,
			anchorWait: { waitMs: 0, now: () => Date.now() }
		});

	it('finds it in small pages when the indexer names no block', async () => {
		const { chain } = scenario();
		const idx = await slowIndexer({
			chain,
			release: { version: VERSION, distribution: { ipfs_cid: CID } },
			instances: peers
		});
		try {
			const r = await underSimulatedTime(resolve(idx.base));
			expect(r?.anchor.sourceSha256).toBe(sha(peerBytes));
			expect(r?.version).toBe(VERSION);
			expect(idx.historyReads()).toBe(3);
		} finally {
			await idx.close();
		}
	});

	it("finds it in the block this node's indexer names, without reading history", async () => {
		const { chain, trxId } = scenario();
		const idx = await slowIndexer({
			chain,
			release: {
				version: VERSION,
				distribution: { ipfs_cid: CID },
				source_block_num: 70_000_001,
				source_trx_id: trxId
			},
			instances: peers
		});
		try {
			const r = await underSimulatedTime(resolve(idx.base));
			expect(r?.anchor.sourceSha256).toBe(sha(peerBytes));
			expect(idx.historyReads()).toBe(0);
		} finally {
			await idx.close();
		}
	});
});

// ─── The same indexer, for `upgrade --from-file` on a hidden-only node ─────

describe('upgrade --from-file on a hidden-only node checks the bundle against the record', () => {
	let work = '';
	let installDir = '';
	let extracted = '';
	const saved = { ...process.env };

	beforeEach(() => {
		work = mkdtempSync(join(scratch, 'run-'));
		installDir = join(work, 'morphit');
		const etcDir = join(work, 'etc');
		mkdirSync(etcDir);
		mkdirSync(join(installDir, '.forgejo', 'release-signers'), { recursive: true });
		writeFileSync(
			join(installDir, 'release-info.json'),
			JSON.stringify({ tag: 'v1.21.16', commit: 'x', build_time: 'x', builder: 'x' })
		);
		const bin = join(work, 'bin');
		mkdirSync(bin);
		extracted = join(work, 'extracted');
		writeFileSync(
			join(bin, 'tar'),
			`#!/bin/sh\ncase " $* " in *" -xzf "*" -C "*) echo "$*" >> '${extracted}' ;; esac\nexec /usr/bin/tar "$@"\n`
		);
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
		chmodSync(join(bin, 'tar'), 0o755);
		chmodSync(join(bin, 'npm'), 0o755);
		process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
		process.env.MORPHIT_INSTALL_DIR = installDir;
		process.env.MORPHIT_ETC_DIR = etcDir;
		process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
		process.env.MORPHIT_WEB_ROOT = join(work, 'www');
		process.env.MORPHIT_SYSTEMD_DIR = join(work, 'systemd');
		process.env.MORPHIT_HELPER_DIR = join(work, 'helpers');
		process.env.MORPHIT_RELEASE_MIRRORS = '';
		// The node's root-owned config: no clearnet RPC node at all.
		const body =
			'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n';
		writeFileSync(join(etcDir, 'indexer.env'), body);
		const envEtc = join(work, 'envroot', 'etc', 'morphit');
		mkdirSync(envEtc, { recursive: true });
		writeFileSync(join(envEtc, 'indexer.env'), body);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		useSimulatedTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	});

	/** An offline bundle for VERSION, and the chain whose record names its hash
	 *  as offline_sha256 (page 3 of the history). */
	function bundle(): { tb: string; chain: PagedChain; trxId: string } {
		const tree = mkdtempSync(join(scratch, 'tree-'));
		writeFileSync(
			join(tree, 'release-info.json'),
			JSON.stringify({ tag: `v${VERSION}`, commit: 'c', build_time: 't', builder: 'b' })
		);
		writeFileSync(join(tree, 'package.json'), '{}');
		writeFileSync(join(tree, 'nonce'), Math.random().toString());
		const tb = join(work, `morphit-v${VERSION}-offline.tar.gz`);
		expect(spawnSync('tar', ['-czf', tb, '-C', tree, '.']).status).toBe(0);
		const real = signedRelease(
			VERSION,
			{
				source_sha256: 'f'.repeat(64),
				offline_sha256: sha(readFileSync(tb)),
				gpg_fingerprint: 'A'.repeat(40),
				note: PAD
			},
			{ blockNum: 70_000_001 }
		);
		const trxId = (real.history[0] as [number, { trx_id: string }])[1].trx_id;
		return { tb, chain: pagedChain(1_201, [{ seq: 1_175, f: real }]), trxId };
	}

	const run = (base: string, tb: string) =>
		runUpgrade({
			flags: { yes: 'true', 'from-file': tb },
			positional: [],
			localIndexerBases: [base],
			verifyLocalIndexer: trustListener,
			trust: { postingPubkey: OFFICIAL_PUB, signerFingerprints: [] },
			anchorWait: { now: () => Date.now() }
		} as never);

	it('reads it in small pages, each given the time a Tor/I2P answer takes', async () => {
		const { tb, chain } = bundle();
		const idx = await slowIndexer({ chain, release: { version: VERSION }, instances: peers });
		try {
			await underSimulatedTime(run(idx.base, tb));
			expect(existsSync(extracted), 'the bundle the signed record names was refused').toBe(true);
		} finally {
			await idx.close();
		}
	});

	it("reads it from the block this node's indexer names", async () => {
		const { tb, chain, trxId } = bundle();
		const idx = await slowIndexer({
			chain,
			release: { version: VERSION, source_block_num: 70_000_001, source_trx_id: trxId },
			instances: peers
		});
		try {
			await underSimulatedTime(run(idx.base, tb));
			expect(existsSync(extracted), 'the bundle the signed record names was refused').toBe(true);
			expect(idx.historyReads()).toBe(0);
		} finally {
			await idx.close();
		}
	});
});
