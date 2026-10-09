/**
 * `morphit-ops upgrade --check-only` on a HIDDEN-ONLY node (v1.18.0 review, O10).
 *
 * The release monitor runs this check every six hours, under a 30-second limit,
 * to tell the operator a newer release exists. On a hidden-only node the check
 * ran the whole hidden upgrade resolution — directory lookup, then a download
 * of the full release tarball over Tor/I2P from a federation peer — only to read
 * a version number. It could not finish in 30 seconds over Tor, so on every
 * tor-only node the monitor reported "check failed" forever and the operator was
 * never told.
 *
 * These drive the real `runUpgrade` against a stub of the node's own indexer and
 * assert what it answers, and that it asked the indexer for nothing but the
 * hidden-only flag and the release record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { runUpgrade } from '../src/commands/upgrade.ts';

interface Stub {
	readonly base: string;
	readonly paths: string[];
	close(): Promise<void>;
}

async function stubIndexer(
	release: { status: number; body: unknown },
	instance: unknown = { clearnet_eliminated: true, clearnet_eliminated_missing: [] }
): Promise<Stub> {
	const paths: string[] = [];
	const server: Server = createServer((req, res) => {
		paths.push(req.url ?? '');
		const send = (status: number, body: unknown): void => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/v1/instance') return send(200, instance);
		if (req.url === '/v1/release') return send(release.status, release.body);
		// The directory: a peer the old code would then have downloaded from.
		if (req.url === '/v1/instances') {
			return send(200, { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] });
		}
		send(404, { error: 'not_found' });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		paths,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

const onChain = (version: string) => ({
	status: 200,
	body: {
		version,
		distribution: { source_sha256: 'a'.repeat(64), ipns_name: 'k51example', ipfs_cid: '' }
	}
});

let installDir = '';
let etcDir = '';
let logged: string[] = [];
const savedEnv = {
	MORPHIT_INSTALL_DIR: process.env.MORPHIT_INSTALL_DIR,
	MORPHIT_ETC_DIR: process.env.MORPHIT_ETC_DIR,
	MORPHIT_RELEASE_HOST: process.env.MORPHIT_RELEASE_HOST,
	MORPHIT_RELEASE_MIRRORS: process.env.MORPHIT_RELEASE_MIRRORS,
	MORPHIT_OFFLINE_RELEASE_DIR: process.env.MORPHIT_OFFLINE_RELEASE_DIR
};

/** The node's root-owned indexer config: hidden-only (empty clearnet pool) or
 *  clearnet. This, and never an HTTP answer, decides hidden-only. */
const configure = (pool: 'hidden' | 'clearnet'): void =>
	writeFileSync(
		join(etcDir, 'indexer.env'),
		pool === 'hidden'
			? 'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n'
			: 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n'
	);

/** Stands in for the /proc check that the listener is morphit-indexer.service
 *  (the stub is a process of this test, so the real check refuses it). */
const trustListener = (): { kind: 'verified'; how: 'override' } => ({
	kind: 'verified',
	how: 'override'
});

beforeEach(() => {
	installDir = mkdtempSync(join(tmpdir(), 'morphit-check-hidden-'));
	etcDir = mkdtempSync(join(tmpdir(), 'morphit-check-etc-'));
	process.env.MORPHIT_ETC_DIR = etcDir;
	// Nothing on the clearnet path may be reachable from a test.
	process.env.MORPHIT_RELEASE_HOST = '127.0.0.1:1';
	process.env.MORPHIT_RELEASE_MIRRORS = '';
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(etcDir, 'no-offline-drops');
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
	);
	process.env.MORPHIT_INSTALL_DIR = installDir;
	logged = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		logged.push(a.map(String).join(' '));
	});
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(installDir, { recursive: true, force: true });
	rmSync(etcDir, { recursive: true, force: true });
});

/** A check on a hidden-only node whose indexer listener is authenticated. */
const check = (base: string) => {
	configure('hidden');
	return runUpgrade({
		flags: { 'check-only': 'true', json: 'true' },
		positional: [],
		localIndexerBases: [base],
		verifyLocalIndexer: trustListener
	});
};

const payload = (): { current: string; latest: string; up_to_date: boolean } =>
	JSON.parse(logged.join('\n')) as { current: string; latest: string; up_to_date: boolean };

describe('upgrade --check-only on a hidden-only node', () => {
	it('reports a newer release from the on-chain record, without contacting any peer', async () => {
		const idx = await stubIndexer(onChain('1.18.0'));
		try {
			const rc = await check(idx.base);
			expect(rc, 'exit 1 is how the release monitor learns a release exists').toBe(1);
			expect(payload()).toMatchObject({
				current: 'v1.17.15',
				latest: 'v1.18.0',
				up_to_date: false
			});
			expect(idx.paths, 'the check went looking for a peer to download from').not.toContain(
				'/v1/instances'
			);
		} finally {
			await idx.close();
		}
	});

	it('reports up to date when the chain names the installed release', async () => {
		const idx = await stubIndexer(onChain('1.17.15'));
		try {
			expect(await check(idx.base)).toBe(0);
			expect(payload()).toMatchObject({ latest: 'v1.17.15', up_to_date: true });
		} finally {
			await idx.close();
		}
	});

	it('an indexer with no release record is a failed check (exit 5), still with no peer contacted', async () => {
		const idx = await stubIndexer({ status: 404, body: { error: 'not_found' } });
		try {
			expect(await check(idx.base)).toBe(5);
			expect(idx.paths).not.toContain('/v1/instances');
		} finally {
			await idx.close();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Whatever answered first on
 * 127.0.0.1 / 172.18.0.1 / 172.17.0.1 port 8081 decided, for ROOT, whether the
 * node is hidden-only, the release it installs, its SHA-256 and its peers — no
 * check on who was listening. Hidden-only now comes from the root-owned config,
 * the listener must be proven to be morphit-indexer.service, the first address
 * with a listener is the only one asked, and an older on-chain release is not
 * "newer".
 */
describe('who decides a hidden-only upgrade', () => {
	it('a clearnet node is never made hidden-only by what port 8081 says', async () => {
		configure('clearnet');
		// An authenticated listener claiming hidden-only (/v1/instance) and
		// offering a release. 2026-10-08: a CHECK on any node reads the on-chain
		// release record from the authenticated indexer (/v1/release); it still
		// never asks the hidden-only questions (/v1/instance) or for peers
		// (/v1/instances), and nothing is downloaded.
		const impostor = await stubIndexer(onChain('9.9.9'));
		try {
			await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [impostor.base],
				verifyLocalIndexer: trustListener
			});
			expect(impostor.paths, 'the clearnet node asked the hidden-only questions').not.toContain(
				'/v1/instance'
			);
			expect(impostor.paths).not.toContain('/v1/instances');
			expect(impostor.paths.every((p) => p === '/v1/release')).toBe(true);
		} finally {
			await impostor.close();
		}
	});

	it('a node whose chain reads are hidden-only is hidden-only, whatever else its indexer reports (H2)', async () => {
		configure('hidden');
		const idx = await stubIndexer(onChain('1.18.0'), {
			clearnet_eliminated: false,
			clearnet_eliminated_missing: ['transportI2p']
		});
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: trustListener
			});
			expect(rc, 'the hidden-only node went to the clearnet release host').toBe(1);
			expect(payload()).toMatchObject({ latest: 'v1.18.0', up_to_date: false });
		} finally {
			await idx.close();
		}
	});

	it('a listener that is not morphit-indexer.service is never asked anything (real /proc check)', async () => {
		configure('hidden');
		// This stub is a socket of the test process — not in the indexer's cgroup
		// and, as root, not owned by the indexer's user either.
		const impostor = await stubIndexer(onChain('9.9.9'));
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [impostor.base]
			});
			expect(rc).toBe(5);
			expect(impostor.paths, 'root sent requests to an unauthenticated listener').toEqual([]);
		} finally {
			await impostor.close();
		}
	});

	it('the first address with a listener is the answer: a failing indexer never hands over to the next address', async () => {
		configure('hidden');
		const first = await stubIndexer({ status: 500, body: { error: 'boom' } });
		const second = await stubIndexer(onChain('9.9.9'));
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [first.base, second.base],
				verifyLocalIndexer: trustListener
			});
			expect(rc).toBe(5);
			expect(second.paths, 'the decision fell through to the next address').toEqual([]);
		} finally {
			await first.close();
			await second.close();
		}
	});

	it('an on-chain release OLDER than the installed one is not offered as newer (ops-2)', async () => {
		const idx = await stubIndexer(onChain('1.17.10'));
		try {
			const rc = await check(idx.base);
			expect(rc, 'a downgrade was reported as a newer release').toBe(0);
			expect(payload()).toMatchObject({
				current: 'v1.17.15',
				latest: 'v1.17.10',
				up_to_date: true
			});
		} finally {
			await idx.close();
		}
	});

	it('a release version that is not a version is refused, not shown (ops-7)', async () => {
		const idx = await stubIndexer(onChain('1.18.0\u001b[2J'));
		try {
			expect(await check(idx.base)).toBe(5);
			expect(logged.join('\n')).not.toContain('\u001b');
		} finally {
			await idx.close();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * 2026-10-08: the release check on a CLEARNET node (what the release monitor
 * runs twice a day). It asked only the code host; morphit.io's menu, asking the
 * same host for 2.5 s, said "couldn't check" while v1.21.2 was out. The check
 * now reads @morphit's on-chain release record from the node's own
 * authenticated indexer first, and asks the code host only when that does not
 * answer.
 */
describe('upgrade --check-only on a clearnet node', () => {
	let asked: string[] = [];
	beforeEach(() => {
		asked = [];
		const real = globalThis.fetch;
		vi.spyOn(globalThis, 'fetch').mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			return real(input, init);
		}) as typeof fetch);
	});
	const codeHostAsked = (): boolean => asked.some((u) => u.includes('127.0.0.1:1/'));

	it('a newer release in the on-chain record is reported without asking the code host', async () => {
		configure('clearnet');
		const idx = await stubIndexer(onChain('1.18.0'));
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: trustListener
			});
			expect(rc, 'exit 1 is how the release monitor learns a release exists').toBe(1);
			expect(payload()).toMatchObject({
				current: 'v1.17.15',
				latest: 'v1.18.0',
				up_to_date: false
			});
			expect(codeHostAsked(), 'the code host was asked though the record answered').toBe(false);
			expect(idx.paths).toEqual(['/v1/release']);
		} finally {
			await idx.close();
		}
	});

	it('up to date when the record names the installed release', async () => {
		configure('clearnet');
		const idx = await stubIndexer(onChain('1.17.15'));
		try {
			expect(
				await runUpgrade({
					flags: { 'check-only': 'true', json: 'true' },
					positional: [],
					localIndexerBases: [idx.base],
					verifyLocalIndexer: trustListener
				})
			).toBe(0);
			expect(payload()).toMatchObject({ latest: 'v1.17.15', up_to_date: true });
		} finally {
			await idx.close();
		}
	});

	it('a check stops at the first release source that answers (the mirrors are not asked too)', async () => {
		// Review 2026-10-08: every source was asked in turn even after the
		// primary had answered; on a network that drops connections that was
		// several 30 s waits, past the release monitor's 90 s limit.
		configure('clearnet');
		process.env.MORPHIT_RELEASE_HOST = 'primary.example';
		process.env.MORPHIT_RELEASE_MIRRORS = 'mirror.example/agorise/morphit';
		vi.mocked(globalThis.fetch).mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			asked.push(u);
			if (u.includes('primary.example'))
				return new Response(
					JSON.stringify({ tag_name: 'v1.18.0', html_url: 'x', body: '', assets: [] }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			throw new TypeError('fetch failed');
		}) as typeof fetch);
		const idx = await stubIndexer({ status: 404, body: { error: 'not_found' } });
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: trustListener
			});
			expect(rc).toBe(1);
			expect(asked.some((u) => u.includes('primary.example'))).toBe(true);
			expect(asked.filter((u) => u.includes('mirror.example'))).toEqual([]);
		} finally {
			await idx.close();
		}
	});

	it('a real upgrade that cannot reach the code host says the record names a newer release', async () => {
		// Review 2026-10-08: the check (menu, release monitor) reads the record,
		// the real upgrade finds releases on the code host. When the code host
		// is blocked, the alert said "v1.18.0 is out" and the upgrade said only
		// "could not reach any release source".
		configure('clearnet');
		const idx = await stubIndexer(onChain('1.18.0'));
		const said: string[] = [];
		vi.mocked(console.error).mockImplementation((...a: unknown[]) => void said.push(a.join(' ')));
		vi.mocked(process.stderr.write).mockImplementation(
			(c: unknown) => (said.push(String(c)), true)
		);
		try {
			const rc = await runUpgrade({
				flags: { yes: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: trustListener
			});
			expect(rc).toBe(5);
			const out = [...said, ...logged].join('\n');
			expect(out).toMatch(/could not reach any release source/i);
			expect(out).toMatch(/on-chain release record names v1\.18\.0/);
		} finally {
			await idx.close();
		}
	});

	it('no record from the indexer: the code host is asked, as before', async () => {
		configure('clearnet');
		const idx = await stubIndexer({ status: 404, body: { error: 'not_found' } });
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: trustListener
			});
			expect(codeHostAsked()).toBe(true);
			// The code host is unreachable in a test: a failed check.
			expect(rc).toBe(5);
		} finally {
			await idx.close();
		}
	});

	it('a listener that is not morphit-indexer.service is never asked (real /proc check)', async () => {
		configure('clearnet');
		const impostor = await stubIndexer(onChain('9.9.9'));
		try {
			const rc = await runUpgrade({
				flags: { 'check-only': 'true', json: 'true' },
				positional: [],
				localIndexerBases: [impostor.base]
			});
			expect(impostor.paths, 'root asked an unauthenticated listener').toEqual([]);
			expect(logged.join('\n')).not.toContain('9.9.9');
			expect(rc).toBe(5);
		} finally {
			await impostor.close();
		}
	});
});
