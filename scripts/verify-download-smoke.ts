/**
 * Smoke — scripts/verify-download.mjs.
 *
 * A downloader runs this to learn whether a tarball is the release @morphit
 * anchored on chain. It must not take one RPC node's word: a node can answer
 * `get_account_history` with a release op it made up. The script proves the op
 * (two operators agree, the block is re-read, the transaction id is recomputed,
 * the signature recovers to the pinned @morphit posting key) with its own
 * built-in secp256k1 and transaction encoding — so those are checked here
 * against dblurt, the library the chain clients use.
 *
 * Stand-in Blurt nodes on 127.0.0.1/.2/.3 (three "operators") serve
 * dblurt-signed fixtures; the real CLI is run against them.
 *
 * Registered: `.:verify-download-smoke`.
 * MORPHIT_VERIFY_DOWNLOAD=<other copy> runs the CLI checks against it.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey, PublicKey, Signature, cryptoUtils } from '@beblurt/dblurt';
import {
	BLURT_MAINNET_CHAIN_ID,
	MORPHIT_OFFICIAL_POSTING_PUBKEY,
	RELEASE_SIGNER_FINGERPRINTS
} from '../packages/operator-config/src/trustAnchors.ts';
import * as vd from './verify-download.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(process.env.MORPHIT_VERIFY_DOWNLOAD ?? join(HERE, 'verify-download.mjs'));
const CHAIN = Buffer.from(BLURT_MAINNET_CHAIN_ID, 'hex');
const FPR = RELEASE_SIGNER_FINGERPRINTS[0]!;
const OFFICIAL = PrivateKey.fromSeed('verify-download smoke: the pinned key');
const OTHER = PrivateKey.fromSeed('verify-download smoke: somebody else');

let scenarios = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	scenarios++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// ─── fixtures ───────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'morphit-verify-'));
const tarball = join(dir, 'morphit-v9.9.9.tar.gz');
writeFileSync(tarball, 'the genuine release bytes\n');
const GOOD_SHA = createHash('sha256').update(readFileSync(tarball)).digest('hex');

interface Fixture {
	history: unknown[];
	blocks: Record<number, unknown>;
}
function release(
	version: string,
	dist: Record<string, unknown>,
	key: PrivateKey | null,
	blockNum: number,
	seq: number
): Fixture {
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: 'morphit_release_v1',
			json: JSON.stringify({ version, hash_manifest: {}, distribution: dist })
		}
	];
	const unsigned = {
		ref_block_num: blockNum & 0xffff,
		ref_block_prefix: 3_000_000_000 + seq,
		expiration: '2026-10-01T00:01:00',
		operations: [op],
		extensions: []
	};
	const tx = (
		key
			? cryptoUtils.signTransaction(unsigned as never, [key], CHAIN)
			: { ...unsigned, signatures: [] }
	) as Record<string, unknown>;
	const trxId = cryptoUtils.generateTrxId(tx as never);
	return {
		history: [
			[seq, { trx_id: trxId, block: blockNum, trx_in_block: 0, op_in_trx: 0, virtual_op: 0, op }]
		],
		blocks: {
			[blockNum]: { block_id: `b${blockNum}`, timestamp: '2026-10-01T00:00:00', transactions: [tx] }
		}
	};
}
const merge = (...fs: Fixture[]): Fixture => ({
	history: fs.flatMap((f) => f.history),
	blocks: Object.assign({}, ...fs.map((f) => f.blocks))
});
const dist = (sha: string, fpr = FPR) => ({
	source_sha256: sha,
	gpg_fingerprint: fpr,
	ipfs_cid: 'bafy-test'
});

/** A stand-in Blurt node at 127.0.0.<n>. */
async function node(n: number, f: () => Fixture): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
			const fx = f();
			const result =
				method === 'condenser_api.get_account_history'
					? fx.history.slice(-Number(params[2]))
					: method === 'condenser_api.get_block'
						? (fx.blocks[Number(params[0])] ?? null)
						: null;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
		});
	});
	await new Promise<void>((r) => server.listen(0, `127.0.0.${n}`, () => r()));
	return { url: `http://127.0.0.${n}:${(server.address() as AddressInfo).port}`, server };
}

function runCli(
	urls: string[],
	extra: string[] = []
): Promise<{ code: number | null; out: string }> {
	return new Promise((res) => {
		const p = spawn(process.execPath, [SCRIPT, tarball, ...extra], {
			env: { ...process.env, MORPHIT_RPC: urls.join(',') }
		});
		let out = '';
		p.stdout.on('data', (c) => (out += c));
		p.stderr.on('data', (c) => (out += c));
		const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
		p.on('close', (code) => {
			clearTimeout(t);
			res({ code, out });
		});
	});
}

console.log('\n── verify-download smoke ─────────────────────────────────\n');

// ─── the pins equal the ones every node-side tool uses ──────────────
const mod = vd as Record<string, unknown>;
check(
	'pins @morphit’s posting key (= operator-config)',
	mod.PINNED_POSTING_PUBKEY === MORPHIT_OFFICIAL_POSTING_PUBKEY
);
check('pins the release GPG fingerprint (= operator-config)', mod.PINNED_GPG_FINGERPRINT === FPR);
check('pins the Blurt chain id (= operator-config)', mod.BLURT_CHAIN_ID === BLURT_MAINNET_CHAIN_ID);
check(
	'decodes the pinned key exactly as dblurt does',
	(mod.publicKeyBytes as (k: string) => Buffer | null)?.(MORPHIT_OFFICIAL_POSTING_PUBKEY)?.toString(
		'hex'
	) === PublicKey.fromString(MORPHIT_OFFICIAL_POSTING_PUBKEY).key.toString('hex')
);
check('imports nothing but Node built-ins', !/from '(?!node:)/.test(readFileSync(SCRIPT, 'utf8')));

// ─── built-in crypto = dblurt ───────────────────────────────────────
const recover = mod.recoverCompressed as ((s: string, d: Buffer) => Buffer | null) | undefined;
const txId = mod.transactionIdOf as ((tx: unknown) => string | null) | undefined;
if (recover && txId) {
	let recOk = 0;
	let idOk = 0;
	for (let i = 0; i < 25; i++) {
		const k = PrivateKey.fromSeed(`k${i}`);
		const json = JSON.stringify({ v: i, pad: randomBytes(i * 7).toString('hex'), u: 'ü€' });
		const tx = cryptoUtils.signTransaction(
			{
				ref_block_num: (i * 4099) & 0xffff,
				ref_block_prefix: (i * 2_654_435_761) >>> 0,
				expiration: `2026-0${1 + (i % 9)}-1${i % 10}T0${i % 10}:3${i % 6}:0${i % 10}`,
				operations: [
					[
						'custom_json',
						{
							required_auths: i % 3 ? [] : ['a'],
							required_posting_auths: ['morphit', `x${i}`],
							id: `id${i}`,
							json
						}
					]
				],
				extensions: []
			} as never,
			[k],
			CHAIN
		) as unknown as { signatures: string[] };
		const digest = cryptoUtils.transactionDigest(tx as never, CHAIN);
		const got = recover(tx.signatures[0]!, digest);
		const want = Signature.fromString(tx.signatures[0]!).recover(digest);
		if (got && new PublicKey(got).toString() === want.toString()) recOk++;
		if (txId(tx) === cryptoUtils.generateTrxId(tx as never)) idOk++;
	}
	check('secp256k1 recovery equals dblurt on 25 signed transactions', recOk === 25, `${recOk}/25`);
	check('transaction id equals dblurt on 25 transactions', idOk === 25, `${idOk}/25`);
} else {
	check('has its own signature recovery and transaction id', false);
}

async function main(): Promise<void> {
	// ─── reading the op: forged, honest, lying nodes (in process) ───────
	const read = mod.readSignedRelease as
		| ((
				call: (u: string, m: string, p: unknown[]) => Promise<unknown>,
				urls: string[],
				o?: { wantVersion?: string | null; pinnedPubkey?: string }
		  ) => Promise<{ ok: boolean; reason?: string; payload?: { version?: string } }>)
		| undefined;
	const compare = vd.compareRelease as (
		sha: string,
		v: unknown,
		w: string | null
	) => { status: string; which?: string };
	const OFFICIAL_PUB = OFFICIAL.createPublic('BLT').toString();
	const genuine = release(
		'9.9.9',
		{ ...dist(GOOD_SHA), offline_sha256: 'c'.repeat(64) },
		OFFICIAL,
		70_000_100,
		100
	);
	const callFor =
		(byUrl: Record<string, Fixture>) =>
		async (u: string, m: string, p: unknown[]): Promise<unknown> => {
			const f = byUrl[u]!;
			return m === 'condenser_api.get_account_history'
				? f.history.slice(-Number(p[2]))
				: (f.blocks[Number(p[0])] ?? null);
		};
	const urls3 = ['https://a.example', 'https://b.example', 'https://c.example'];
	if (read) {
		const ok = await read(
			callFor({ [urls3[0]!]: genuine, [urls3[1]!]: genuine, [urls3[2]!]: genuine }),
			urls3,
			{
				pinnedPubkey: OFFICIAL_PUB
			}
		);
		check(
			'honest nodes, op signed by the pinned key → proved',
			ok.ok === true && ok.payload?.version === '9.9.9'
		);
		check('  …the tarball matches', compare(GOOD_SHA, ok, null).status === 'match');
		check(
			'  …the offline bundle matches its own hash',
			compare('c'.repeat(64), ok, null).which === 'offline'
		);
		check('  …another file does not', compare('b'.repeat(64), ok, null).status === 'mismatch');

		const liar = merge(genuine, release('9.9.10', dist('d'.repeat(64)), OTHER, 70_000_200, 101));
		const r1 = await read(
			callFor({ [urls3[0]!]: liar, [urls3[1]!]: genuine, [urls3[2]!]: genuine }),
			urls3,
			{
				pinnedPubkey: OFFICIAL_PUB
			}
		);
		check(
			'one node invents a newer op → the two agreeing nodes win',
			r1.ok === true && r1.payload?.version === '9.9.9'
		);

		const unrelated = release('9.9.9', dist('e'.repeat(64)), OFFICIAL, 70_000_100, 100);
		const r2 = await read(
			callFor({ [urls3[0]!]: genuine, [urls3[1]!]: unrelated }),
			urls3.slice(0, 2),
			{
				pinnedPubkey: OFFICIAL_PUB
			}
		);
		check(
			'two nodes disagree on the block → nothing is known',
			r2.ok === false && r2.reason === 'no_quorum'
		);

		const one = await read(callFor({ [urls3[0]!]: genuine }), [urls3[0]!, `${urls3[0]}/other`], {
			pinnedPubkey: OFFICIAL_PUB
		});
		check('two URLs of one operator are one voice', one.ok === false && one.reason === 'no_quorum');

		const old = merge(release('9.9.8', dist('f'.repeat(64)), OFFICIAL, 70_000_050, 99), genuine);
		const r3 = await read(callFor({ [urls3[0]!]: old, [urls3[1]!]: old }), urls3.slice(0, 2), {
			pinnedPubkey: OFFICIAL_PUB,
			wantVersion: 'v9.9.8'
		});
		check('--version finds that version’s op', r3.ok === true && r3.payload?.version === '9.9.8');
		check(
			'a proved anchor naming another GPG key is refused',
			compare(
				GOOD_SHA,
				{ ...ok, payload: { version: '9.9.9', distribution: dist(GOOD_SHA, 'A'.repeat(40)) } },
				null
			).status === 'signer_changed'
		);
		check(
			'compareRelease refuses anything not proved',
			compare(GOOD_SHA, { ok: false, reason: 'bad_signature' }, null).status === 'unverified'
		);
	} else {
		check('reads the release op through a proof (readSignedRelease)', false);
	}

	// ─── the CLI against stand-in nodes ─────────────────────────────────
	// The real pinned key's private half is not here, so every op the stand-ins
	// serve is, correctly, not @morphit's.
	const forged = release('9.9.9', dist(GOOD_SHA), OTHER, 70_000_100, 100);
	const unsigned = release('9.9.9', dist(GOOD_SHA), null, 70_000_100, 100);
	const nodes = await Promise.all([1, 2, 3].map((n) => node(n, () => current)));
	let current: Fixture = forged;
	const all = nodes.map((n) => n.url);

	const f1 = await runCli(all);
	check(
		'CLI: every node serves an op signed by another key → refused (exit 1)',
		f1.code === 1,
		`exit ${f1.code}: ${f1.out.slice(-300)}`
	);
	check('  …and it says the op is not signed by @morphit', /NOT signed/.test(f1.out));
	current = unsigned;
	const f2 = await runCli(all);
	check('CLI: an unsigned op → refused (exit 1)', f2.code === 1, `exit ${f2.code}`);
	const f3 = await runCli([all[0]!]);
	check('CLI: a single node is never enough (exit 3)', f3.code === 3, `exit ${f3.code}`);

	for (const n of nodes) n.server.close();

	console.log(`\n${'─'.repeat(54)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} verify-download scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} verify-download scenarios failed`);
		process.exit(1);
	}
}
void main();
