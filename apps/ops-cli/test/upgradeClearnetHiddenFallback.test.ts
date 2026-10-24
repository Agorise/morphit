/**
 * v1.21.15 — a CLEARNET node whose every release source (the code host and its
 * mirrors) does not answer gets the release from the other Morphit instances
 * over Tor/I2P, verified against @morphit's signed record — the owner's rule:
 * when a clearnet source is not reachable, try the hidden ones. Through the real
 * runUpgrade (harness from upgradeHiddenWait.test.ts).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
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
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

let peerBytes: Buffer = Buffer.alloc(0);
/** What a peer answers: the bytes, or a failure (a peer without the release). */
let peerFails: string | null = null;
let peerAsks = 0;
/** Runs while a peer is asked (a test can change the box meanwhile). */
let duringFetch: (() => void) | null = null;
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async (url: string) => {
		peerAsks++;
		duringFetch?.();
		if (peerFails !== null) throw new Error(peerFails.replace('URL', url));
		return new Uint8Array(peerBytes);
	}
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-hidden-npm-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CID = `bafy${'a'.repeat(55)}`;
const peers = {
	instances: [{ name: 'Morphit', alt_networks: { tor: `${'p'.repeat(56)}.onion` } }]
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A lockfile whose workspace version is `wsVersion` and with `leftPad` installed. */
function lock(wsVersion: string, leftPad: string): string {
	return JSON.stringify({
		name: 'morphit',
		version: wsVersion,
		lockfileVersion: 3,
		packages: {
			'': { name: 'morphit', version: wsVersion, workspaces: ['apps/ops-cli'] },
			'apps/ops-cli': {
				name: 'morphit-ops',
				version: wsVersion,
				dependencies: { 'left-pad': '*' }
			},
			'node_modules/morphit-ops': { resolved: 'apps/ops-cli', link: true },
			'node_modules/left-pad': {
				version: leftPad,
				resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${leftPad}.tgz`,
				integrity: `sha512-${leftPad}`
			}
		}
	});
}

/** A slim release tarball for v1.18.0 carrying `lockText` and a prebuilt frontend. */
function slimRelease(lockText: string): Buffer {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag: 'v1.18.0', commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	writeFileSync(join(tree, 'package-lock.json'), lockText);
	mkdirSync(join(tree, 'apps', 'web', 'build'), { recursive: true });
	writeFileSync(join(tree, 'apps', 'web', 'build', 'index.html'), '<html></html>');
	mkdirSync(join(tree, 'apps', 'ops-cli'), { recursive: true });
	const out = join(scratch, `rel-${Math.random().toString(36).slice(2)}.tar.gz`);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return readFileSync(out);
}

let work = '';
let installDir = '';
let etcDir = '';
let npmLog = '';
const saved = { ...process.env };

beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	installDir = join(work, 'morphit');
	etcDir = join(work, 'etc');
	mkdirSync(etcDir);
	mkdirSync(join(installDir, 'node_modules', 'left-pad'), { recursive: true });
	mkdirSync(join(installDir, 'apps', 'ops-cli'), { recursive: true });
	writeFileSync(
		join(installDir, 'node_modules', 'left-pad', 'package.json'),
		JSON.stringify({ name: 'left-pad', version: '1.3.0' })
	);
	spawnSync('ln', ['-s', '../apps/ops-cli', join(installDir, 'node_modules', 'morphit-ops')]);
	writeFileSync(join(installDir, 'package-lock.json'), lock('1.17.15', '1.3.0'));
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
	);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	npmLog = join(work, 'npm.log');
	// `npm` that records its arguments and every proxy setting it was given.
	writeFileSync(
		join(bin, 'npm'),
		`#!/bin/sh\n{ echo "ARGS $*"; env | grep -iE '^[^=]*proxy[^=]*=' | sort; echo END; } >> '${npmLog}'\nexit 1\n`
	);
	chmodSync(join(bin, 'npm'), 0o755);
	process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
	process.env.HTTPS_PROXY = 'http://inherited-proxy.example:3128';
	process.env.MORPHIT_INSTALL_DIR = installDir;
	process.env.MORPHIT_ETC_DIR = etcDir;
	process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
	process.env.MORPHIT_WEB_ROOT = join(work, 'www');
	process.env.MORPHIT_SYSTEMD_DIR = join(work, 'systemd');
	process.env.MORPHIT_HELPER_DIR = join(work, 'helpers');
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

function clearnetNode(): void {
	writeFileSync(
		join(etcDir, 'indexer.env'),
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:1\n'
	);
	// A primary that refuses at once, and (not the canonical primary) no
	// built-in mirrors: every clearnet release source fails.
	process.env.MORPHIT_RELEASE_HOST = '127.0.0.1:1';
	process.env.MORPHIT_RELEASE_REPO = 'agorise/morphit';
	delete process.env.MORPHIT_RELEASE_MIRRORS;
}

const out = (): string =>
	(process.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
		.map((c) => String(c[0]))
		.join('');
const err = (): string =>
	(process.stderr.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
		.map((c) => String(c[0]))
		.join('');

async function upgradeWith(
	releaseBytes: Buffer,
	onchainVersion: string,
	flags: Record<string, string> = { yes: 'true' },
	served: Buffer = releaseBytes
): Promise<number> {
	peerBytes = served;
	const idx = await stubIndexer({
		release: {
			version: onchainVersion,
			distribution: { source_sha256: sha(releaseBytes), ipfs_cid: CID }
		},
		instances: peers,
		chain: signedRelease(onchainVersion, { source_sha256: sha(releaseBytes), ipfs_cid: CID })
	});
	let t = 0;
	try {
		return await runUpgrade({
			flags,
			positional: [],
			localIndexerBases: [idx.base],
			verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
			trust: { postingPubkey: OFFICIAL_PUB },
			anchorWait: { now: () => t, sleep: async (ms: number) => void (t += ms) },
			hiddenWait: { now: () => t, sleep: async (ms: number) => void (t += ms), interactive: false }
		} as never);
	} finally {
		await idx.close();
	}
}

describe('a clearnet node whose release sources do not answer', () => {
	beforeEach(() => {
		clearnetNode();
		peerAsks = 0;
		peerFails = null;
		duringFetch = null;
	});

	it('gets the newer release from the federation over Tor/I2P and installs it as verified', async () => {
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		const o = out();
		expect(peerAsks).toBe(1);
		expect(o).toMatch(/No release source answered over clearnet, so this server gets the release/);
		expect(o).toMatch(/✓ Got v1\.18\.0 from Morphit, .*\(over Tor\/I2P\)/);
		expect(o).toMatch(/Integrity verified \(hidden-federation-onchain-sha256\)/);
		// Still a clearnet node for the rest: npm is not told to stay offline.
		const npm = readFileSync(npmLog, 'utf8');
		expect(npm).toMatch(/^ARGS ci/m);
		expect(npm).not.toMatch(/--offline/);
		// The install itself then runs (this harness's npm stub fails it, so the
		// upgrade rolls back); what matters is that it was reached, verified.
		expect(code).not.toBe(0);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toMatch(/v1\.17\.15/);
	});

	it('a copy that does not match the signed SHA-256 is refused: nothing installed, exit 5', async () => {
		const good = slimRelease(lock('1.18.0', '1.3.0'));
		const forged = slimRelease(lock('1.18.0', '9.9.9'));
		const code = await upgradeWith(good, '1.18.0', { yes: 'true' }, forged);
		expect(code).toBe(5);
		expect(peerAsks).toBeGreaterThan(0);
		expect(out()).not.toMatch(/Integrity verified/);
		expect(existsSync(npmLog), 'npm never ran').toBe(false);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toMatch(/v1\.17\.15/);
	});

	it('asks no instance for a release this server already runs', async () => {
		const code = await upgradeWith(slimRelease(lock('1.17.15', '1.3.0')), '1.17.15');
		expect(code).toBe(5);
		expect(peerAsks).toBe(0);
		expect(err()).toMatch(/Could not reach any release source/);
	});

	it('says what Tor/I2P answered too when no instance has a copy, and changes nothing', async () => {
		peerFails = 'hidden upgrade: HTTP 404 from URL';
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		expect(code).toBe(5);
		expect(peerAsks).toBe(1);
		expect(err()).toMatch(/Could not reach any release source/);
		expect(err()).toMatch(/Tor\/I2P \(the other Morphit instances\): /);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toMatch(/v1\.17\.15/);
	});

	it('an OLDER tarball left in the offline drop dir does not stop the Tor/I2P fallback', async () => {
		const drop = join(work, 'drops');
		mkdirSync(drop, { recursive: true });
		writeFileSync(
			join(drop, 'morphit-v1.17.0-offline.tar.gz'),
			slimRelease(lock('1.17.0', '1.3.0'))
		);
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = drop;
		await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		expect(peerAsks).toBe(1);
		expect(out()).toMatch(/Integrity verified \(hidden-federation-onchain-sha256\)/);
	});

	it('`--json` never runs the fallback (stdout stays JSON only)', async () => {
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0', {
			json: 'true'
		});
		expect(peerAsks).toBe(0);
		expect(out()).not.toMatch(/No release source answered over clearnet/);
		void code;
	});

	it('`--check-only` never runs the fallback (it downloads nothing)', async () => {
		await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0', { 'check-only': 'true' });
		expect(peerAsks).toBe(0);
		expect(out()).not.toMatch(/No release source answered over clearnet/);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toMatch(/v1\.17\.15/);
	});

	it('a NEWER tarball the operator dropped in the offline dir is used — no instance is asked', async () => {
		const drop = join(work, 'drops');
		mkdirSync(drop, { recursive: true });
		writeFileSync(
			join(drop, 'morphit-v1.18.0-offline.tar.gz'),
			slimRelease(lock('1.18.0', '1.3.0'))
		);
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = drop;
		await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		expect(peerAsks).toBe(0);
		expect(out()).not.toMatch(/No release source answered over clearnet/);
	});

	it('another upgrade changing this server during the fetch stops this one, changing nothing', async () => {
		duringFetch = () =>
			writeFileSync(
				join(installDir, 'release-info.json'),
				JSON.stringify({ tag: 'v1.18.0', commit: 'y', build_time: 'y', builder: 'y' })
			);
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		expect(code).toBe(5);
		expect(out()).toMatch(/This server now runs v1\.18\.0: another upgrade changed it/);
		expect(out()).not.toMatch(/Integrity verified/);
		expect(existsSync(npmLog), 'npm never ran').toBe(false);
	});

	it('no instance reachable over Tor/I2P: says to check that Tor runs', async () => {
		peerFails = 'hidden upgrade: connect ECONNREFUSED 127.0.0.1:1 (URL)';
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), '1.18.0');
		expect(code).toBe(5);
		expect(err()).toMatch(/is Tor running on this server\? \(sudo systemctl status tor\)/);
		expect(err()).not.toMatch(/that release is out/);
	});
});
