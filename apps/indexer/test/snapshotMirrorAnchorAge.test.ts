/**
 * morphit.io, v1.21.17: snapshot-mirror said "already mirroring the newest
 * snapshot (block 64,288,040) — nothing to do." while the chain was at
 * ~64,889,065: the anchored snapshot was about 21 days old, because anchoring
 * is a manual step on the laptop and newer exports sat pinned, unanchored. The
 * line now says how old the anchored snapshot is, and on the box that
 * publishes it, past two days, how many exports wait and the exact commands
 * that anchor the newest, on the laptop (v1.21.17 audit, M4).
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	anchorReminder,
	publishWorkdir,
	snapshotAgeWords,
	waitingExports
} from '../scripts/snapshot-mirror.ts';
import { INDEXER_SNAPSHOT_OP_ID } from '../src/blurt/indexerSnapshotOp';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');

const dir = mkdtempSync(join(tmpdir(), 'snap-age-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the anchored snapshot’s age', () => {
	it('morphit.io’s numbers: about 21 days', () => {
		expect(snapshotAgeWords(64_288_040, 64_889_065)).toEqual({
			words: 'about 21 days old',
			days: expect.closeTo(20.87, 1)
		});
	});
	it('fresh, and unknown', () => {
		expect(snapshotAgeWords(100, 100 + 1200)?.words).toBe('less than two hours old');
		expect(snapshotAgeWords(100, 100 + 28_800)?.words).toBe('about 24 hours old');
		expect(snapshotAgeWords(100, null)).toBeNull();
	});
});

describe('on the publishing box, past two days', () => {
	for (const b of [64_288_040, 64_860_000, 64_889_180])
		writeFileSync(join(dir, `indexer-snapshot-payload-${b}.json`), '{}');
	writeFileSync(join(dir, 'unrelated.json'), '{}');

	it('the exports newer than the anchored one, newest first', () => {
		expect(waitingExports(dir, 64_288_040).map((w) => w.block)).toEqual([64_889_180, 64_860_000]);
	});

	it('how many wait, and the exact laptop commands for the newest', () => {
		const lines = anchorReminder({
			days: 21,
			waiting: waitingExports(dir, 64_288_040),
			host: 'example.org'
		});
		const t = lines.join('\n');
		expect(t).toMatch(/2 newer exports are pinned here but not anchored on chain/);
		expect(t).toMatch(/on your laptop, in your Morphit folder:/);
		expect(t).toContain(
			`scp -O root@example.org:${join(dir, 'indexer-snapshot-payload-64889180.json')} .`
		);
		expect(t).toContain(
			'node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts indexer-snapshot-payload-64889180.json --broadcast'
		);
		expect(t).not.toContain('<this-node>');
		// A server that refuses root logins (PermitRootLogin no): via /tmp.
		expect(t).toMatch(/If this server refuses root logins \(PermitRootLogin no\)/);
		expect(t).toContain(
			`on this server:  sudo install -m 0644 ${join(dir, 'indexer-snapshot-payload-64889180.json')} /tmp/`
		);
		expect(t).toContain(
			'on your laptop:  scp -O <your-login>@example.org:/tmp/indexer-snapshot-payload-64889180.json .'
		);
	});

	it('nothing past two days is fresh enough: no reminder', () => {
		expect(
			anchorReminder({ days: 1, waiting: waitingExports(dir, 0), host: 'example.org' })
		).toEqual([]);
	});
});

describe('without a web address', () => {
	it('the copy command names this server by its own name, never a placeholder', () => {
		const t = anchorReminder({
			days: 21,
			waiting: [
				{ block: 5, path: '/var/lib/ipfs/.ipfs/indexer-snapshots/indexer-snapshot-payload-5.json' }
			],
			host: null
		}).join('\n');
		expect(t).toContain(`scp -O root@${hostname()}:`);
		expect(t).not.toMatch(/<this server>|<this-node>/);
	});
});

describe('where the publisher keeps its exports', () => {
	it('its own WORKDIR setting, else its default inside the IPFS repo', () => {
		expect(publishWorkdir(null, '/var/lib/ipfs/.ipfs')).toBe(
			'/var/lib/ipfs/.ipfs/indexer-snapshots'
		);
		expect(publishWorkdir('MORPHIT_SNAPSHOT_KEEP=3\n', '/r')).toBe('/r/indexer-snapshots');
		expect(publishWorkdir('WORKDIR=/srv/a\nexport WORKDIR="/srv/b"\n', '/r')).toBe('/srv/b');
		expect(publishWorkdir("WORKDIR='/srv/c'\n", '/r')).toBe('/srv/c');
		expect(publishWorkdir('WORKDIR=relative\n', '/r')).toBe('/r/indexer-snapshots');
	});
});

/**
 * The real script, against two JSON-RPC stubs that agree on a genuinely signed
 * snapshot op, and stand-in `runuser` / `ipfs` on PATH. Review, 2026-10-29: the
 * age of the anchored snapshot was said only when it was already mirrored —
 * not when a new one was pinned, nor that it could not be read when the chain
 * could not be; and the exports waiting were looked for where nothing put them.
 */
describe('every way a mirror run ends says how old the anchored snapshot is', () => {
	const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
	const HEAD = 9_000_000;
	const HEAD_TIME = '2026-09-24T00:00:00';
	const SNAP = 8_913_600; // 3 days of 3-second blocks before the head
	const CID = 'bafy' + 'a'.repeat(55);
	const servers: http.Server[] = [];
	afterAll(async () => {
		await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
	});

	async function signedChain(sha256: string): Promise<{ urls: string[]; pub: string }> {
		const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
		const key = PrivateKey.fromSeed('snapshot-mirror-age-official-posting');
		const payload = {
			ipfs_cid: CID,
			sha256,
			chain_id: CHAIN_ID,
			schema_version: 70,
			last_applied_block: SNAP,
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
				ref_block_num: 1,
				ref_block_prefix: 2,
				expiration: '2026-09-24T00:01:00',
				operations: [op],
				extensions: []
			} as never,
			[key],
			Buffer.from(CHAIN_ID, 'hex')
		) as unknown as Record<string, unknown>;
		const trxId = cryptoUtils.generateTrxId(tx as never);
		const opBlock = HEAD - 10;
		const urls: string[] = [];
		for (const host of ['127.0.0.1', 'localhost']) {
			const server = http.createServer((req, res) => {
				let body = '';
				req.on('data', (c) => (body += c));
				req.on('end', () => {
					const j = JSON.parse(body) as { id?: number; method?: string; params?: unknown[] };
					let result: unknown = null;
					if (j.method === 'condenser_api.get_account_history')
						result = [
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
						];
					else if (j.method === 'condenser_api.get_block')
						result =
							Number((j.params ?? [])[0]) === opBlock
								? {
										block_id: 'b',
										previous: 'p',
										timestamp: HEAD_TIME,
										witness: 'w',
										transactions: [tx],
										transaction_ids: [trxId]
									}
								: null;
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
			urls.push(`http://${host}:${(server.address() as { port: number }).port}`);
		}
		return { urls, pub: key.createPublic().toString() };
	}

	/** A box with stand-in kubo; `pinned`: kubo already holds the CID. */
	function box(o: { pinned: boolean; state: boolean }): {
		root: string;
		env: Record<string, string>;
	} {
		const root = mkdtempSync(join(tmpdir(), 'snap-mirror-run-'));
		mkdirSync(join(root, 'bin'));
		writeFileSync(
			join(root, 'bin', 'runuser'),
			'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
			{ mode: 0o755 }
		);
		writeFileSync(
			join(root, 'bin', 'ipfs'),
			[
				'#!/bin/sh',
				`D=${root}`,
				'case "$1" in',
				'  id) echo peer ;;',
				`  pin) if [ "$2" = ls ]; then [ -f "$D/pinned" ] && echo "${CID} recursive"; exit 0; fi; [ "$2" = add ] && touch "$D/pinned"; exit 0 ;;`,
				'  swarm) echo /ip4/192.0.2.1/tcp/4001/p2p/peer ;;',
				'  cat) cat "$D/snap.tar.gz" ;;',
				'  *) exit 0 ;;',
				'esac',
				''
			].join('\n'),
			{ mode: 0o755 }
		);
		if (o.pinned) writeFileSync(join(root, 'pinned'), '');
		if (o.state)
			writeFileSync(
				join(root, 'state.json'),
				JSON.stringify({ cid: CID, sha256: '', lastAppliedBlock: SNAP, mirroredAt: '' })
			);
		// The publisher's settings name its own folder for the exports.
		mkdirSync(join(root, 'exports'));
		writeFileSync(join(root, 'exports', `indexer-snapshot-payload-${SNAP + 1000}.json`), '{}');
		writeFileSync(join(root, 'snapshot-publish.env'), `WORKDIR=${join(root, 'exports')}\n`);
		return {
			root,
			env: {
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				MORPHIT_SNAPSHOT_MIRROR_STATE: join(root, 'state.json'),
				MORPHIT_SNAPSHOT_PUBLISH_ENV: join(root, 'snapshot-publish.env'),
				IPFS_PATH: join(root, 'ipfs-repo')
			}
		};
	}

	function mirror(env: Record<string, string>, rpcs: string[], pub: string): Promise<string> {
		return new Promise((res) => {
			const p = spawn(
				TSX,
				[
					'--tsconfig',
					join(REPO, 'tsconfig.smoke.json'),
					join(REPO, 'apps/indexer/scripts/snapshot-mirror.ts')
				],
				{
					cwd: REPO,
					env: {
						...process.env,
						MORPHIT_INDEXER_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never-used',
						MORPHIT_INDEXER_CHAIN_ID: CHAIN_ID,
						MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://node.example.org',
						MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: pub,
						MORPHIT_INDEXER_RPC_ENDPOINTS: '',
						MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: '',
						MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: rpcs.join(','),
						MORPHIT_RPC_HEALTH_STATE: join(env.MORPHIT_SNAPSHOT_MIRROR_STATE!, '..', 'health.json'),
						...env
					},
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			let out = '';
			p.stdout.on('data', (d) => (out += d));
			p.stderr.on('data', (d) => (out += d));
			p.on('close', () => res(out));
		});
	}

	it('already mirrored: its age, and the export waiting in the publisher’s own folder', async () => {
		const chain = await signedChain('ab'.repeat(32));
		const b = box({ pinned: true, state: true });
		const out = await mirror(b.env, chain.urls, chain.pub);
		expect(out).toContain(
			'already mirroring the newest anchored snapshot (block 8,913,600, about 3 days old)'
		);
		expect(out).toContain(join(b.root, 'exports', `indexer-snapshot-payload-${SNAP + 1000}.json`));
		expect(out).toContain('scp -O root@node.example.org:');
		rmSync(b.root, { recursive: true, force: true });
	}, 90_000);

	it('a new snapshot pinned: its age is said there too', async () => {
		// The dump the signed op names, inside the archive kubo hands back.
		const work = mkdtempSync(join(tmpdir(), 'snap-mirror-dump-'));
		writeFileSync(join(work, 'indexer.sql.gz'), 'dump-bytes');
		const sha = createHash('sha256').update('dump-bytes').digest('hex');
		const chain = await signedChain(sha);
		const b = box({ pinned: false, state: false });
		expect(
			spawnSync('tar', ['-czf', join(b.root, 'snap.tar.gz'), '-C', work, 'indexer.sql.gz']).status
		).toBe(0);
		const out = await mirror(b.env, chain.urls, chain.pub);
		expect(out).toContain('newest snapshot: block 8,913,600 (about 3 days old)');
		expect(out).toContain(
			'this instance now mirrors the federation snapshot (block 8,913,600, about 3 days old)'
		);
		expect(out).toContain(`indexer-snapshot-payload-${SNAP + 1000}.json`);
		rmSync(b.root, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}, 90_000);

	it('the chain cannot be read: says its age could not be read either', async () => {
		const b = box({ pinned: true, state: true });
		const out = await mirror(
			b.env,
			['http://127.0.0.1:1', 'http://localhost:1'],
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9'
		);
		expect(out).toMatch(/could not be read/);
		expect(out).not.toContain('already mirroring');
		rmSync(b.root, { recursive: true, force: true });
	}, 90_000);
});
