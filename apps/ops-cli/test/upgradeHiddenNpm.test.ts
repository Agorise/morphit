/**
 * A hidden-only (zero-clearnet) upgrade never lets npm reach the registry from
 * the box's own address.
 *
 * Before: the release fetched over Tor/I2P was the slim tarball, so step 9 ran
 * a plain `npm ci` — a direct connection to registry.npmjs.org — or, with no
 * clearnet route, failed and rolled back.
 *
 * These drive the real runUpgrade on a hidden-only node (root-owned config with
 * an empty clearnet pool) whose release record is signed; `npm` is a stub that
 * records every call with its proxy environment. Plus the Tor bridge itself,
 * against a stand-in SOCKS server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	createServer as createNetServer,
	connect as netConnect,
	type Server as NetServer
} from 'node:net';
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
import type { AddressInfo } from 'node:net';
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');
const { startTorRegistryBridge, dependencyFingerprint } = await import('../src/lib/depsInstall.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-hidden-npm-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CID = `bafy${'a'.repeat(55)}`;
const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };
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

const npmCalls = (): string[] =>
	existsSync(npmLog)
		? readFileSync(npmLog, 'utf8')
				.split('END\n')
				.filter((b) => b.trim() !== '')
		: [];
const installCalls = (): string[] => npmCalls().filter((c) => /^ARGS (ci|install)\b/.test(c));

function hiddenNode(socks: string): void {
	writeFileSync(
		join(etcDir, 'indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=${socks}\n`
	);
}

async function upgradeTo(releaseBytes: Buffer): Promise<number> {
	peerBytes = releaseBytes;
	const idx = await stubIndexer({
		release: {
			version: '1.18.0',
			distribution: { source_sha256: sha(releaseBytes), ipfs_cid: CID }
		},
		instances: peers,
		chain: signedRelease('1.18.0', {
			source_sha256: sha(releaseBytes),
			ipfs_cid: CID,
			gpg_fingerprint: 'A'.repeat(40)
		})
	});
	try {
		return await runUpgrade({
			flags: { yes: 'true' },
			positional: [],
			localIndexerBases: [idx.base],
			verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
			trust: { postingPubkey: OFFICIAL_PUB }
		} as never);
	} finally {
		await idx.close();
	}
}

/** A stand-in for Tor's SOCKS port: answers the greeting, records each CONNECT
 *  target, and refuses it. */
async function fakeSocks(): Promise<{ addr: string; asked: string[]; close(): Promise<void> }> {
	const asked: string[] = [];
	const server: NetServer = createNetServer((s) => {
		let acc = Buffer.alloc(0);
		let greeted = false;
		s.on('data', (d: Buffer) => {
			acc = Buffer.concat([acc, d]);
			if (!greeted && acc.length >= 3) {
				greeted = true;
				acc = acc.subarray(3);
				s.write(Buffer.from([0x05, 0x00]));
			}
			if (greeted && acc.length >= 5 && acc[3] === 0x03 && acc.length >= 7 + acc[4]!) {
				const host = acc.subarray(5, 5 + acc[4]!).toString('ascii');
				asked.push(`${host}:${acc.readUInt16BE(5 + acc[4]!)}`);
				s.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			}
		});
		s.on('error', () => undefined);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		addr: `127.0.0.1:${port}`,
		asked,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

describe('a hidden-only upgrade of a slim release', () => {
	it('with unchanged dependencies runs no npm install and reuses the previous node_modules', async () => {
		hiddenNode('127.0.0.1:1');
		await upgradeTo(slimRelease(lock('1.18.0', '1.3.0')));
		expect(installCalls(), 'npm was asked to install from the registry').toEqual([]);
		expect(existsSync(join(installDir, 'node_modules', 'left-pad', 'package.json'))).toBe(true);
	});

	it('with changed dependencies and no Tor, refuses and never runs npm', async () => {
		hiddenNode('127.0.0.1:1');
		const rc = await upgradeTo(slimRelease(lock('1.18.0', '1.3.1')));
		expect(installCalls(), 'npm ran with no private route').toEqual([]);
		expect(rc).not.toBe(0);
		expect(JSON.parse(readFileSync(join(installDir, 'release-info.json'), 'utf8')).tag).toBe(
			'v1.17.15'
		);
	});

	it('with changed dependencies and Tor up, npm gets only the loopback bridge as its proxy and no scripts', async () => {
		const socks = await fakeSocks();
		try {
			hiddenNode(socks.addr);
			await upgradeTo(slimRelease(lock('1.18.0', '1.3.1')));
			const calls = installCalls();
			expect(calls.length).toBe(1);
			const call = calls[0]!;
			expect(call).toMatch(/^ARGS ci .*--ignore-scripts/);
			const proxies = call.split('\n').filter((l) => /=/.test(l));
			expect(proxies.length).toBeGreaterThan(0);
			for (const l of proxies) {
				const v = l.slice(l.indexOf('=') + 1);
				expect(v === '' || /^http:\/\/127\.0\.0\.1:\d+$/.test(v), l).toBe(true);
			}
			expect(call).not.toMatch(/inherited-proxy/);
		} finally {
			await socks.close();
		}
	});
});

describe('the Tor registry bridge', () => {
	let socks: Awaited<ReturnType<typeof fakeSocks>>;
	beforeAll(async () => {
		socks = await fakeSocks();
	});
	afterAll(async () => socks.close());

	const connectVia = (port: number, target: string): Promise<string> =>
		new Promise((r) => {
			const c = netConnect({ host: '127.0.0.1', port });
			let got = '';
			c.on('connect', () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
			c.on('data', (d) => (got += d.toString()));
			c.on('close', () => r(got));
			c.on('error', () => r(got));
		});

	it('opens the registry through SOCKS by NAME, so Tor resolves it', async () => {
		const [h, p] = socks.addr.split(':');
		const b = await startTorRegistryBridge({ socksHost: h!, socksPort: Number(p) });
		try {
			await connectVia(b.port, 'registry.npmjs.org:443');
			expect(socks.asked).toContain('registry.npmjs.org:443');
		} finally {
			await b.close();
		}
	});

	it('refuses any other target without dialling it', async () => {
		const [h, p] = socks.addr.split(':');
		const b = await startTorRegistryBridge({ socksHost: h!, socksPort: Number(p) });
		const before = socks.asked.length;
		try {
			expect(await connectVia(b.port, 'evil.example:443')).toMatch(/403/);
			expect(await connectVia(b.port, '104.16.0.1:443')).toMatch(/403/);
			expect(socks.asked.length).toBe(before);
		} finally {
			await b.close();
		}
	});
});

describe('dependencyFingerprint', () => {
	it('ignores the workspace version bump every release makes', () => {
		expect(dependencyFingerprint(lock('1.17.15', '1.3.0'))).toBe(
			dependencyFingerprint(lock('1.18.0', '1.3.0'))
		);
	});
	it('changes when an installed package changes', () => {
		expect(dependencyFingerprint(lock('1.18.0', '1.3.0'))).not.toBe(
			dependencyFingerprint(lock('1.18.0', '1.3.1'))
		);
	});
});
