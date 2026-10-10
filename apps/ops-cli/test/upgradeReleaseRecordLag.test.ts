/**
 * One node's answer is not the chain (morphit.io, v1.21.2 → v1.21.3,
 * 2026-10-08).
 *
 * WHAT WENT WRONG. The upgrade read @morphit's release record through ONE
 * history answer: this node's indexer relays the read to whichever pool node
 * answers first. When that answer did not hold the record (a node behind the
 * chain, or a record broadcast a minute earlier that the node's history did not
 * list yet), the upgrade refused: "@morphit has published no release record
 * for v1.21.3", and the operator hit a wall in the middle of the ceremony.
 *
 * NOW. The record is authenticated by its signature, so WHERE it is read from
 * does not matter, and a missing record in one answer proves nothing. The
 * upgrade asks this node's indexer and, on a node allowed to use clearnet, each
 * configured Blurt node directly; when none holds it yet it asks again for up
 * to three minutes (under the spinner) before refusing. A pinned signature
 * needs no record, so it never waits.
 *
 * These drive the real runUpgrade. "Accepted" is observed as the tarball being
 * extracted into the install dir (a `tar` wrapper records it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { OFFICIAL_PUB, signedRelease, stubIndexer, stubNode } from './helpers/releaseChain.ts';

let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-lag-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

function releaseTarball(dir: string, tag: string): string {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag, commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	writeFileSync(join(tree, 'nonce'), Math.random().toString());
	const out = join(dir, `morphit-${tag}.tar.gz`);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return out;
}

let work = '';
let installDir = '';
let etcDir = '';
let extracted = '';
const saved = { ...process.env };

const gnupg = join(scratch, 'gnupg');
let signerFpr = '';
const gpg = (args: string[]) =>
	spawnSync(
		'gpg',
		['--homedir', gnupg, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
		{
			encoding: 'utf8'
		}
	);
beforeAll(() => {
	mkdirSync(gnupg, { mode: 0o700 });
	expect(
		gpg(['--quick-gen-key', 'Pinned Signer <p@example.invalid>', 'ed25519', 'sign', 'never']).status
	).toBe(0);
	signerFpr =
		/^fpr:+([0-9A-F]{40}):/m.exec(gpg(['--with-colons', '--list-keys']).stdout)?.[1] ?? '';
	expect(signerFpr).toMatch(/^[0-9A-F]{40}$/);
});
beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	installDir = join(work, 'morphit');
	etcDir = join(work, 'etc');
	mkdirSync(etcDir);
	mkdirSync(join(installDir, '.forgejo', 'release-signers'), { recursive: true });
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
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
	process.env.MORPHIT_RPC_HEALTH_STATE = join(work, 'rpc-health.json');
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

/** A configured clearnet node that refuses at once (nothing listens on port 9):
 *  never a name that resolves, so no test reaches the internet. */
const DEAD_NODE = 'http://127.0.0.1:9';

/** The node's root-owned indexer config: hidden-only, or these clearnet nodes. */
function configure(pool: 'hidden' | string[]): void {
	const body =
		pool === 'hidden'
			? 'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n'
			: `MORPHIT_INDEXER_RPC_ENDPOINTS=${pool.join(',')}\n`;
	// On a server both are /etc/morphit/indexer.env; the tests move each root.
	writeFileSync(join(etcDir, 'indexer.env'), body);
	mkdirSync(join(work, 'envroot', 'etc', 'morphit'), { recursive: true });
	writeFileSync(join(work, 'envroot', 'etc', 'morphit', 'indexer.env'), body);
}

/** A virtual clock: waiting advances it instantly. */
function clock() {
	let t = 1_000_000;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		waited: () => t - 1_000_000
	};
}

function run(
	base: string,
	flags: Record<string, string>,
	c: ReturnType<typeof clock>,
	signerFingerprints: string[] = []
) {
	return runUpgrade({
		flags: { yes: 'true', ...flags },
		positional: [],
		localIndexerBases: [base],
		verifyLocalIndexer: trustListener,
		trust: { postingPubkey: OFFICIAL_PUB, signerFingerprints },
		anchorWait: { now: c.now, sleep: c.sleep }
	} as never);
}

describe("one node's answer without the release record does not block the upgrade", () => {
	it('the first answer lacks the record (a node behind), a later one holds it: it waits and goes ahead', async () => {
		configure([DEAD_NODE]);
		const tb = releaseTarball(work, 'v1.18.0');
		const rec = signedRelease('1.18.0', {
			source_sha256: sha(tb),
			gpg_fingerprint: 'A'.repeat(40)
		});
		const idx = await stubIndexer({ chain: rec, historyAnswers: [[], [], rec.history] });
		const c = clock();
		try {
			await run(idx.base, { 'from-file': tb }, c);
			expect(wasExtracted(), 'one answer without the record refused the upgrade').toBe(true);
			expect(idx.historyCalls()).toBeGreaterThanOrEqual(3);
			expect(c.waited()).toBeLessThanOrEqual(180_000);
		} finally {
			await idx.close();
		}
	});

	it("this node's indexer never lists it, but a configured Blurt node does: accepted from that node", async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		const rec = signedRelease('1.18.0', {
			source_sha256: sha(tb),
			gpg_fingerprint: 'A'.repeat(40)
		});
		const node = await stubNode(rec);
		configure([node.url]);
		const idx = await stubIndexer({ chain: rec, historyAnswers: [[]] });
		const c = clock();
		try {
			await run(idx.base, { 'from-file': tb }, c);
			expect(wasExtracted(), 'a node holding the signed record was never asked').toBe(true);
			expect(node.historyCalls()).toBeGreaterThanOrEqual(1);
		} finally {
			await idx.close();
			await node.close();
		}
	});

	it('a record that no source ever holds is still refused, after three minutes of asking, with nothing changed', async () => {
		configure([DEAD_NODE]);
		const tb = releaseTarball(work, 'v1.18.0');
		const idx = await stubIndexer({ historyAnswers: [[]] });
		const c = clock();
		try {
			expect(await run(idx.base, { 'from-file': tb }, c)).toBe(5);
			expect(wasExtracted()).toBe(false);
			expect(
				c.waited(),
				'it gave up without waiting for a record broadcast moments ago'
			).toBeGreaterThanOrEqual(170_000);
			expect(c.waited()).toBeLessThanOrEqual(190_000);
			expect(JSON.parse(readFileSync(join(installDir, 'release-info.json'), 'utf8')).tag).toBe(
				'v1.17.15'
			);
		} finally {
			await idx.close();
		}
	});

	it('a release signed by a pinned key needs no record, so it never waits for one', async () => {
		configure([DEAD_NODE]);
		const tb = releaseTarball(work, 'v1.18.0');
		expect(gpg(['--armor', '--detach-sign', '--output', `${tb}.asc`, tb]).status).toBe(0);
		writeFileSync(
			join(installDir, '.forgejo', 'release-signers', 'pinned.asc'),
			gpg(['--armor', '--export', 'p@example.invalid']).stdout
		);
		const idx = await stubIndexer({ historyAnswers: [[]] });
		const c = clock();
		try {
			await run(idx.base, { 'from-file': tb }, c, [signerFpr]);
			expect(wasExtracted()).toBe(true);
			expect(c.waited(), 'a signed release waited for a chain record it does not need').toBe(0);
		} finally {
			await idx.close();
		}
	});

	it('while it waits, each source is asked for its newest page only (a late record is among the newest entries)', async () => {
		configure([DEAD_NODE]);
		const tb = releaseTarball(work, 'v1.18.0');
		// A full page of other ops, its lowest sequence number 501: the first
		// round may page back; a waiting round must not.
		const filler = Array.from({ length: 500 }, (_, i) => [
			1000 - i,
			{ trx_id: 'f'.repeat(40), block: 1, op: ['vote', {}] }
		]);
		const idx = await stubIndexer({ historyAnswers: [filler] });
		const c = clock();
		try {
			expect(await run(idx.base, { 'from-file': tb }, c)).toBe(5);
			const rounds = Math.floor(c.waited() / 10_000) + 1;
			expect(
				idx.historyCalls(),
				'every waiting round paged back through history'
			).toBeLessThanOrEqual(4 + rounds + 1);
		} finally {
			await idx.close();
		}
	});

	it('a forged record on the first source does not stop the genuine one on the next', async () => {
		const tb = releaseTarball(work, 'v1.18.0');
		const genuine = signedRelease('1.18.0', {
			source_sha256: sha(tb),
			gpg_fingerprint: 'A'.repeat(40)
		});
		const node = await stubNode(genuine);
		configure([node.url]);
		const { OTHER } = await import('./helpers/releaseChain.ts');
		const forged = signedRelease(
			'1.18.0',
			{ source_sha256: 'e'.repeat(64), gpg_fingerprint: 'A'.repeat(40) },
			{ key: OTHER }
		);
		const idx = await stubIndexer({ chain: forged });
		const c = clock();
		try {
			await run(idx.base, { 'from-file': tb }, c);
			expect(wasExtracted()).toBe(true);
		} finally {
			await idx.close();
			await node.close();
		}
	});
});

describe('the hidden-only upgrade asks its indexer again', () => {
	const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };
	const CID = `bafy${'a'.repeat(55)}`;

	it('the first history answer lacks the record, a later one holds it: fetched and accepted', async () => {
		configure('hidden');
		const tb = releaseTarball(work, 'v1.18.0');
		peerBytes = readFileSync(tb);
		const rec = signedRelease('1.18.0', {
			source_sha256: sha(tb),
			ipfs_cid: CID,
			gpg_fingerprint: 'A'.repeat(40)
		});
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: sha(tb), ipfs_cid: CID } },
			instances: peers,
			chain: rec,
			historyAnswers: [[], rec.history]
		});
		const c = clock();
		try {
			await run(idx.base, {}, c);
			expect(wasExtracted(), 'the hidden path believed one answer without the record').toBe(true);
		} finally {
			await idx.close();
		}
	});
});
