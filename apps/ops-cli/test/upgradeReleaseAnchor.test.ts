/**
 * What `morphit-ops upgrade` accepts as proof that a tarball is the release
 * @morphit published.
 *
 * Before: the clearnet path installed an UNSIGNED tarball whose hash matched
 * the Forgejo primary's own `.sha256`; the offline and hidden paths took the
 * expected hash from the local indexer's `/v1/release`; and any good signature
 * from a key the tarball's predecessor shipped in `.forgejo/release-signers/`
 * counted. None of those is an anchor a compromised host or one RPC node
 * cannot produce.
 *
 * Now every path needs either the hash in a `morphit_release_v1` op whose
 * signature recovers to the pinned @morphit posting key, or a valid signature
 * from a pinned GPG fingerprint; and a chain hash that differs from the
 * primary's refuses.
 *
 * These drive the real runUpgrade. "Accepted" is observed as the tarball being
 * extracted into the install dir (a `tar` wrapper records it); a refused
 * tarball never reaches extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
	OFFICIAL_PUB,
	OTHER,
	signedRelease,
	stubIndexer,
	fixtureReader,
	mergeFixtures,
	type ChainFixture
} from './helpers/releaseChain.ts';

// The hidden path's Tor/I2P fetcher is replaced by one that hands back whatever
// bytes the test put up, as a hostile peer would.
let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');
const { readSignedReleaseAnchor } = await import('../src/lib/releaseAnchor.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-anchor-'));
const gnupg = join(scratch, 'gnupg');
const signerPub = join(scratch, 'signer.asc');
let signerFpr = '';
const certDir = join(scratch, 'tls');

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

beforeAll(() => {
	mkdirSync(gnupg, { mode: 0o700 });
	const gpg = (args: string[]) =>
		spawnSync(
			'gpg',
			['--homedir', gnupg, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
			{
				encoding: 'utf8'
			}
		);
	expect(
		gpg(['--quick-gen-key', 'Not A Release Signer <x@example.invalid>', 'ed25519', 'sign', 'never'])
			.status
	).toBe(0);
	writeFileSync(signerPub, gpg(['--armor', '--export', 'x@example.invalid']).stdout);
	signerFpr =
		/^fpr:+([0-9A-F]{40}):/m.exec(gpg(['--with-colons', '--list-keys']).stdout)?.[1] ?? '';
	expect(signerFpr).toMatch(/^[0-9A-F]{40}$/);
	mkdirSync(certDir);
	expect(
		spawnSync('openssl', [
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'1',
			'-subj',
			'/CN=127.0.0.1',
			'-keyout',
			join(certDir, 'k.pem'),
			'-out',
			join(certDir, 'c.pem')
		]).status
	).toBe(0);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function signWithUnpinnedKey(file: string): void {
	const r = spawnSync(
		'gpg',
		[
			'--homedir',
			gnupg,
			'--batch',
			'--pinentry-mode',
			'loopback',
			'--passphrase',
			'',
			'--armor',
			'--detach-sign',
			'--output',
			`${file}.asc`,
			file
		],
		{ encoding: 'utf8' }
	);
	expect(r.status, r.stderr).toBe(0);
}

/** A release tarball for `tag` (its release-info.json names the same tag). */
function releaseTarball(dir: string, tag: string, name = `morphit-${tag}.tar.gz`): string {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag, commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	writeFileSync(join(tree, 'nonce'), Math.random().toString());
	const out = join(dir, name);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return out;
}

let work = '';
let installDir = '';
let etcDir = '';
let extracted = '';
const saved = { ...process.env };

beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	installDir = join(work, 'morphit');
	etcDir = join(work, 'etc');
	mkdirSync(etcDir);
	mkdirSync(join(installDir, '.forgejo', 'release-signers'), { recursive: true });
	// The PREVIOUS release shipped this key as a signer; it is not a pinned one.
	writeFileSync(
		join(installDir, '.forgejo', 'release-signers', 'shipped.asc'),
		readFileSync(signerPub)
	);
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
	);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	extracted = join(work, 'extracted');
	// `tar` that records an extraction INTO a directory (-x … -C), then does it.
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
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

const wasExtracted = (): boolean => existsSync(extracted);
const trustListener = () => ({ kind: 'verified' as const, how: 'override' as const });

/** The node's root-owned indexer config. */
const configure = (pool: 'hidden' | 'clearnet'): void =>
	writeFileSync(
		join(etcDir, 'indexer.env'),
		pool === 'hidden'
			? 'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n'
			: 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.invalid\n'
	);

function run(base: string, flags: Record<string, string>, signerFingerprints: string[] = []) {
	return runUpgrade({
		flags: { yes: 'true', ...flags },
		positional: [],
		localIndexerBases: [base],
		verifyLocalIndexer: trustListener,
		trust: { postingPubkey: OFFICIAL_PUB, signerFingerprints }
	} as never);
}

/** A Forgejo primary over HTTPS serving `files` as the release assets. */
async function primary(
	tag: string,
	files: string[]
): Promise<{ host: string; close(): Promise<void> }> {
	let port = 0;
	const server: HttpsServer = createHttpsServer(
		{ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) },
		(req, res) => {
			if (req.url?.endsWith('/releases/latest')) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						tag_name: tag,
						name: tag,
						body: 'notes',
						html_url: 'https://example.invalid',
						published_at: '2026-10-01T00:00:00Z',
						assets: files.map((f) => ({
							name: basename(f),
							browser_download_url: `https://127.0.0.1:${port}/dl/${basename(f)}`,
							size: 1
						}))
					})
				);
				return;
			}
			const f = files.find((x) => req.url === `/dl/${basename(x)}`);
			if (f) {
				res.writeHead(200);
				res.end(readFileSync(f));
				return;
			}
			res.writeHead(404);
			res.end();
		}
	);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	port = (server.address() as AddressInfo).port;
	return {
		host: `127.0.0.1:${port}`,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

function withSha(tb: string): string {
	writeFileSync(`${tb}.sha256`, `${sha(tb)}  ${basename(tb)}\n`);
	return `${tb}.sha256`;
}

describe('the clearnet upgrade no longer takes the primary at its word', () => {
	beforeEach(() => {
		configure('clearnet');
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
	});

	it('refuses an unsigned release when the chain has no signed record for it', async () => {
		const dl = join(work, 'dl');
		mkdirSync(dl);
		const tb = releaseTarball(dl, 'v1.18.0');
		const p = await primary('v1.18.0', [tb, withSha(tb)]);
		const idx = await stubIndexer({});
		process.env.MORPHIT_RELEASE_HOST = p.host;
		try {
			const rc = await run(idx.base, {});
			expect(wasExtracted(), 'an unsigned tarball was installed on the primary’s word').toBe(false);
			expect(rc).toBe(5);
		} finally {
			await p.close();
			await idx.close();
		}
	});

	it('refuses when the chain names a different hash than the primary', async () => {
		const dl = join(work, 'dl');
		mkdirSync(dl);
		const tb = releaseTarball(dl, 'v1.18.0');
		const p = await primary('v1.18.0', [tb, withSha(tb)]);
		const idx = await stubIndexer({
			chain: signedRelease('1.18.0', {
				source_sha256: 'e'.repeat(64),
				gpg_fingerprint: 'A'.repeat(40)
			})
		});
		process.env.MORPHIT_RELEASE_HOST = p.host;
		try {
			expect(await run(idx.base, {})).toBe(5);
			expect(wasExtracted()).toBe(false);
		} finally {
			await p.close();
			await idx.close();
		}
	});

	it('a good signature from a key the old release shipped, but that is not pinned, is not enough', async () => {
		const dl = join(work, 'dl');
		mkdirSync(dl);
		const tb = releaseTarball(dl, 'v1.18.0');
		signWithUnpinnedKey(tb);
		const p = await primary('v1.18.0', [tb, withSha(tb), `${tb}.asc`]);
		const idx = await stubIndexer({});
		process.env.MORPHIT_RELEASE_HOST = p.host;
		try {
			expect(await run(idx.base, {})).toBe(5);
			expect(wasExtracted(), 'an unpinned signer was trusted').toBe(false);
		} finally {
			await p.close();
			await idx.close();
		}
	});

	it('the same signature from a PINNED fingerprint is accepted', async () => {
		const dl = join(work, 'dl');
		mkdirSync(dl);
		const tb = releaseTarball(dl, 'v1.18.0');
		signWithUnpinnedKey(tb);
		const p = await primary('v1.18.0', [tb, withSha(tb), `${tb}.asc`]);
		const idx = await stubIndexer({});
		process.env.MORPHIT_RELEASE_HOST = p.host;
		try {
			await run(idx.base, {}, [signerFpr]);
			expect(wasExtracted()).toBe(true);
		} finally {
			await p.close();
			await idx.close();
		}
	});

	it('an unsigned release whose hash the signed chain record names is accepted', async () => {
		const dl = join(work, 'dl');
		mkdirSync(dl);
		const tb = releaseTarball(dl, 'v1.18.0');
		const p = await primary('v1.18.0', [tb, withSha(tb)]);
		const idx = await stubIndexer({
			chain: signedRelease('1.18.0', { source_sha256: sha(tb), gpg_fingerprint: 'A'.repeat(40) })
		});
		process.env.MORPHIT_RELEASE_HOST = p.host;
		try {
			await run(idx.base, {});
			expect(wasExtracted()).toBe(true);
		} finally {
			await p.close();
			await idx.close();
		}
	});
});

describe('the offline (--from-file) upgrade', () => {
	beforeEach(() => configure('clearnet'));

	it('does not trust /v1/release: a matching hash there with no signed chain record is refused', async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: sha(tb) } },
			chain: signedRelease(
				'1.18.0',
				{ source_sha256: sha(tb), gpg_fingerprint: 'A'.repeat(40) },
				{ key: OTHER }
			)
		});
		try {
			expect(await run(idx.base, { 'from-file': tb })).toBe(5);
			expect(wasExtracted(), 'the indexer’s word installed an unsigned tarball').toBe(false);
		} finally {
			await idx.close();
		}
	});

	it('accepts an unsigned tarball whose hash the SIGNED chain record names', async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		const idx = await stubIndexer({
			chain: signedRelease('1.18.0', { source_sha256: sha(tb), gpg_fingerprint: 'A'.repeat(40) })
		});
		try {
			await run(idx.base, { 'from-file': tb });
			expect(wasExtracted()).toBe(true);
		} finally {
			await idx.close();
		}
	});

	it('an offline bundle is checked against the signed offline_sha256, which /v1/release never carries', async () => {
		const tb = releaseTarball(work, 'v1.18.0', 'morphit-v1.18.0-offline.tar.gz');
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: 'f'.repeat(64) } },
			chain: signedRelease('1.18.0', {
				source_sha256: 'f'.repeat(64),
				offline_sha256: sha(tb),
				gpg_fingerprint: 'A'.repeat(40)
			})
		});
		try {
			await run(idx.base, { 'from-file': tb });
			expect(wasExtracted()).toBe(true);
		} finally {
			await idx.close();
		}
	});
});

describe('the hidden-only upgrade verifies the release op itself', () => {
	beforeEach(() => configure('hidden'));
	const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };
	const CID = `bafy${'a'.repeat(55)}`;

	it('a forged /v1/release (and a peer serving those bytes) is refused', async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		peerBytes = readFileSync(tb);
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: sha(tb), ipfs_cid: CID } },
			instances: peers,
			chain: signedRelease('1.18.0', {
				source_sha256: 'e'.repeat(64),
				ipfs_cid: CID,
				gpg_fingerprint: 'A'.repeat(40)
			})
		});
		try {
			expect(await run(idx.base, {})).toBe(5);
			expect(wasExtracted(), 'a forged release reached the install').toBe(false);
		} finally {
			await idx.close();
		}
	});

	it('the release the signed op names is fetched and passes the gate', async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		peerBytes = readFileSync(tb);
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: sha(tb), ipfs_cid: CID } },
			instances: peers,
			chain: signedRelease('1.18.0', {
				source_sha256: sha(tb),
				ipfs_cid: CID,
				gpg_fingerprint: 'A'.repeat(40)
			})
		});
		try {
			await run(idx.base, {});
			expect(wasExtracted()).toBe(true);
		} finally {
			await idx.close();
		}
	});
});

describe('readSignedReleaseAnchor', () => {
	const args = {
		tag: 'v1.18.0',
		signer: 'morphit',
		pinnedPubkey: OFFICIAL_PUB,
		chainId: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
	};

	it('returns the hashes from the signed transaction in the block', async () => {
		const f = signedRelease('1.18.0', {
			source_sha256: 'a'.repeat(64),
			offline_sha256: 'b'.repeat(64),
			gpg_fingerprint: 'c'.repeat(40)
		});
		const r = await readSignedReleaseAnchor(fixtureReader(f), args);
		expect(r).toMatchObject({
			ok: true,
			anchor: { sourceSha256: 'a'.repeat(64), offlineSha256: 'b'.repeat(64) }
		});
	});

	it('refuses an op signed by any other key', async () => {
		const f = signedRelease(
			'1.18.0',
			{ source_sha256: 'a'.repeat(64), gpg_fingerprint: 'c'.repeat(40) },
			{ key: OTHER }
		);
		expect((await readSignedReleaseAnchor(fixtureReader(f), args)).ok).toBe(false);
	});

	it('refuses a block whose transaction content was altered under its real signature', async () => {
		const f = signedRelease('1.18.0', {
			source_sha256: 'a'.repeat(64),
			gpg_fingerprint: 'c'.repeat(40)
		});
		const blk = Object.values(f.blocks)[0] as {
			transactions: Array<{ operations: Array<[string, { json: string }]> }>;
		};
		const op = blk.transactions[0]!.operations[0]![1];
		op.json = op.json.replace('a'.repeat(64), 'd'.repeat(64));
		expect((await readSignedReleaseAnchor(fixtureReader(f), args)).ok).toBe(false);
	});

	it('takes the hash from the block, not from what the history answer claims', async () => {
		const real = signedRelease('1.18.0', {
			source_sha256: 'a'.repeat(64),
			gpg_fingerprint: 'c'.repeat(40)
		});
		const h = (real.history[0] as [number, { op: [string, { json: string }] }])[1].op[1];
		h.json = h.json.replace('a'.repeat(64), 'd'.repeat(64));
		const r = await readSignedReleaseAnchor(fixtureReader(real), args);
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
	});

	it('skips a forged newer entry and finds the genuine one', async () => {
		const forged = signedRelease(
			'1.18.0',
			{ source_sha256: 'd'.repeat(64), gpg_fingerprint: 'c'.repeat(40) },
			{ key: OTHER, blockNum: 70_000_100, seq: 50 }
		);
		const real = signedRelease(
			'1.18.0',
			{ source_sha256: 'a'.repeat(64), gpg_fingerprint: 'c'.repeat(40) },
			{ seq: 40 }
		);
		const r = await readSignedReleaseAnchor(
			fixtureReader(mergeFixtures(forged, real) as ChainFixture),
			args
		);
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
	});
});
