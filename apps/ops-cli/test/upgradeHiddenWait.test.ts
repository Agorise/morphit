/**
 * v1.21.6 — a zero-clearnet upgrade whose release is not reachable over Tor/I2P
 * YET explains itself and offers a way forward, through the real runUpgrade
 * (harness from upgradeHiddenNpm.test.ts).
 *
 * morphitlat, 2026-10-10: two upgrades stopped with a red ✗ and a nested error;
 * the third went through a minute later. Now: a plain explanation, what each
 * instance answered, "nothing was changed", and — at a terminal — try again
 * now, keep trying by itself, or stop for now.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

let peerBytes: Buffer = Buffer.alloc(0);
/** What a peer answers: the bytes, or a failure (a peer without the release). */
let peerFails: string | null = null;
let peerAsks = 0;
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async (url: string) => {
		peerAsks++;
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

function hiddenNode(socks: string): void {
	writeFileSync(
		join(etcDir, 'indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=${socks}\n`
	);
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
	hiddenWait: Record<string, unknown>,
	flags: Record<string, string> = {}
): Promise<number> {
	peerBytes = releaseBytes;
	const idx = await stubIndexer({
		release: {
			version: '1.18.0',
			distribution: { source_sha256: sha(releaseBytes), ipfs_cid: CID }
		},
		instances: peers,
		chain: signedRelease('1.18.0', { source_sha256: sha(releaseBytes), ipfs_cid: CID })
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
			hiddenWait: { now: () => t, sleep: async (ms: number) => void (t += ms), ...hiddenWait }
		} as never);
	} finally {
		await idx.close();
	}
}

describe('a zero-clearnet upgrade that has to wait for the federation', () => {
	beforeEach(() => {
		hiddenNode('127.0.0.1:1');
		peerAsks = 0;
		peerFails = 'hidden upgrade: HTTP 404 from URL';
	});

	it('unattended: explains, names what each instance answered, changes nothing, exit 5', async () => {
		const code = await upgradeWith(
			slimRelease(lock('1.18.0', '1.3.0')),
			{ interactive: false },
			{
				yes: 'true'
			}
		);
		expect(code).toBe(5);
		const o = out();
		expect(o).toMatch(/Not yet: no instance could share v1\.18\.0 over Tor\/I2P/);
		expect(o).toMatch(/over both Tor and I2P/);
		expect(o).toMatch(/Morphit \(Tor\): does not have v1\.18\.0 yet/);
		expect(o).toMatch(/Nothing was changed: this server still runs v1\.17\.15/);
		expect(o).toMatch(/\(For support: hidden-upgrade: no federation peer served/);
		expect(o).not.toMatch(/What would you like to do/);
		expect(err()).not.toMatch(/Hidden-only upgrade could not be completed/);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toMatch(/v1\.17\.15/);
	});

	it('"try again now", then "stop for now": searched twice, nothing changed', async () => {
		const answers = ['retry', 'later'];
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), {
			interactive: true,
			ask: async () => answers.shift()
		});
		expect(code).toBe(5);
		expect(peerAsks).toBe(2);
		const o = out();
		expect(o.match(/What would you like to do\?/g)?.length).toBe(2);
		expect(o).toMatch(/1\. Try again now/);
		expect(o).toMatch(/OK — nothing was changed\. When more trusted instances have upgraded/);
	});

	it('"keep trying by itself": one calm line per try for an hour, then asks again', async () => {
		const answers = ['keep-trying', 'later'];
		const code = await upgradeWith(slimRelease(lock('1.18.0', '1.3.0')), {
			interactive: true,
			ask: async () => answers.shift()
		});
		expect(code).toBe(5);
		const o = out();
		// The first search, then a try every 5 minutes for up to an hour.
		expect(peerAsks).toBe(13);
		expect(
			o.match(/⏳ Try \d+: not reachable over Tor\/I2P yet \(1 address without a copy yet\)/g)
				?.length
		).toBe(11);
		expect(o).toMatch(/Kept trying for 60 min 00 s \(13 tries in all\)/);
		expect(o.match(/What would you like to do\?/g)?.length).toBe(2);
	});

	it('a try that finds the release goes on to the upgrade', async () => {
		const answers = ['retry'];
		const bytes = slimRelease(lock('1.18.0', '1.3.0'));
		let tries = 0;
		const code = await upgradeWith(
			bytes,
			{
				interactive: true,
				ask: async () => {
					tries++;
					peerFails = null; // an instance has upgraded meanwhile
					return answers.shift();
				}
			},
			{ yes: 'true' }
		);
		expect(tries).toBe(1);
		expect(peerAsks).toBe(2);
		expect(out()).toMatch(/✓ Got v1\.18\.0 from Morphit, /);
		// It went on to install (this harness's npm stub then fails the install;
		// what matters here is that the search no longer stopped it).
		expect(out()).toMatch(/Integrity verified \(hidden-federation-onchain-sha256\)/);
		void code;
	});
	it('`--yes` at a terminal never asks what to do (unattended: explains and stops)', async () => {
		const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
		Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		let asked = 0;
		try {
			const code = await upgradeWith(
				slimRelease(lock('1.18.0', '1.3.0')),
				{ ask: async () => (asked++, 'later') },
				{ yes: 'true' }
			);
			expect(code).toBe(5);
		} finally {
			Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
			Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
		}
		expect(asked).toBe(0);
		expect(peerAsks).toBe(1);
	});
});
