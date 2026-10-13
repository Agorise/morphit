/**
 * Fast-sync fetches the snapshot through this server's own IPFS node.
 *
 * 2026-10-12, a fresh clearnet VPS: the three sources were this box's gateway
 * (404 — it serves only what the box already holds), ipfs.io and dweb.link
 * (both 429, rate-limited). The box's own kubo daemon, which takes part in the
 * public IPFS network, was never asked. Now it is, before the public gateways —
 * and never on a hidden-only node, whose kubo stays off the public network.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshotSources } from '../../src/blurt/snapshotMirrors';
import {
	defaultIpfsGateways,
	fetchViaKubo,
	kuboCatCommand,
	kuboGatewayFrom
} from '../../src/blurt/snapshotKuboFetch';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ONION = 'a'.repeat(56) + '.onion';
const base = {
	cid: CID,
	forgejoUrl: 'https://git.example.org/snap.tar.gz',
	peers: [{ tor: ONION }],
	publicGateways: ['https://ipfs.io', 'https://dweb.link'],
	localGateway: 'http://127.0.0.1:8082'
};

describe('the IPFS node as a snapshot source', () => {
	it('a clearnet node asks its own IPFS node before any public gateway or the https mirror', () => {
		const s = buildSnapshotSources({ ...base, hiddenOnly: false, localNode: true });
		const order = s.map((x) => x.transport);
		const kubo = order.indexOf('kubo');
		expect(kubo).toBeGreaterThan(order.indexOf('local'));
		expect(kubo).toBeGreaterThan(order.indexOf('tor'));
		expect(kubo).toBeLessThan(order.indexOf('clearnet'));
		expect(s[kubo]!.url).toContain(CID);
	});

	it('a hidden-only node never does (its IPFS node stays off the public network)', () => {
		const s = buildSnapshotSources({ ...base, hiddenOnly: true, localNode: true });
		expect(s.some((x) => x.transport === 'kubo')).toBe(false);
	});

	it('not without an IPFS node', () => {
		const s = buildSnapshotSources({ ...base, hiddenOnly: false });
		expect(s.some((x) => x.transport === 'kubo')).toBe(false);
	});

	it('runs `ipfs cat` as the IPFS user, on its repo, with a time limit', () => {
		const [cmd, args] = kuboCatCommand(CID, {
			user: 'ipfs',
			repo: '/var/lib/ipfs/.ipfs',
			runuser: true
		});
		expect([cmd, ...args]).toEqual([
			'runuser',
			'-u',
			'ipfs',
			'--',
			'env',
			'IPFS_PATH=/var/lib/ipfs/.ipfs',
			'ipfs',
			'--timeout=30m',
			'cat',
			CID
		]);
		const [cmd2, args2] = kuboCatCommand(CID, { user: 'ipfs', repo: '/r', runuser: false });
		expect([cmd2, ...args2].slice(0, 4)).toEqual(['sudo', '-n', '-u', 'ipfs']);
	});

	it('reads no more than the signed size', () => {
		const [, args] = kuboCatCommand(CID, {
			user: 'ipfs',
			repo: '/r',
			runuser: true,
			maxBytes: 23961
		});
		expect(args.slice(-3)).toEqual(['cat', '--length=23961', CID]);
	});

	it('refuses anything but a CID', () => {
		expect(() =>
			kuboCatCommand('QmX; rm -rf /', { user: 'ipfs', repo: '/r', runuser: true })
		).toThrow();
		// A real CID with anything after it, too (the pattern is anchored at both ends).
		expect(() =>
			kuboCatCommand(`${CID} --api=/ip4/1.2.3.4/tcp/5001`, {
				user: 'ipfs',
				repo: '/r',
				runuser: true
			})
		).toThrow();
		expect(() =>
			kuboCatCommand(`--api=x ${CID}`, { user: 'ipfs', repo: '/r', runuser: true })
		).toThrow();
	});
});

describe('this box’s own gateway', () => {
	it('is never guessed as 127.0.0.1:8080 — on a Morphit node that is the relay', () => {
		// The fresh VPS's "127.0.0.1" source answered 404: it was the relay.
		expect(defaultIpfsGateways().some((g) => /127\.0\.0\.1|localhost/.test(g))).toBe(false);
		expect(defaultIpfsGateways().length).toBeGreaterThan(0);
	});

	it('is read from the IPFS node’s own config (root has no repo of its own)', () => {
		const cfg = JSON.stringify({ Addresses: { Gateway: '/ip4/127.0.0.1/tcp/8082' } });
		expect(kuboGatewayFrom(cfg)).toBe('http://127.0.0.1:8082');
		expect(
			kuboGatewayFrom(JSON.stringify({ Addresses: { Gateway: '/ip4/0.0.0.0/tcp/8082' } }))
		).toBe('http://127.0.0.1:8082');
		expect(
			kuboGatewayFrom(JSON.stringify({ Addresses: { Gateway: ['/ip4/127.0.0.1/tcp/8082'] } }))
		).toBe('http://127.0.0.1:8082');
		expect(kuboGatewayFrom('not json')).toBeNull();
		expect(kuboGatewayFrom(JSON.stringify({ Addresses: {} }))).toBeNull();
	});
});

describe('the hidden Blurt RPC nodes as snapshot mirrors', () => {
	// Every node knows their addresses from its own settings before it has an
	// indexer — the one set of hidden addresses a brand-new Tor/I2P-only node
	// always has. docs/HIDDEN-RPC-SNAPSHOT-MIRROR.md is what they serve.
	const RPC_ONION = 'f'.repeat(56) + '.onion';
	const RPC_I2P = 'z'.repeat(52) + '.b32.i2p';
	const rpc = [`http://${RPC_ONION}:8091`, `http://${RPC_I2P}:8091/`, 'https://rpc.example.org'];

	it('are asked at /ipfs/<cid> on the same address and port, over their own network', () => {
		const s = buildSnapshotSources({ ...base, hiddenOnly: true, rpcMirrors: rpc });
		expect(s).toContainEqual(
			expect.objectContaining({ url: `http://${RPC_ONION}:8091/ipfs/${CID}`, transport: 'tor' })
		);
		expect(s).toContainEqual(
			expect.objectContaining({ url: `http://${RPC_I2P}:8091/ipfs/${CID}`, transport: 'i2p' })
		);
		// A clearnet RPC node is never one: a hidden-only node must not dial it.
		expect(s.some((x) => x.url.includes('rpc.example.org'))).toBe(false);
	});

	it('come after the Morphit instances, and on a clearnet node after its own IPFS node', () => {
		const s = buildSnapshotSources({
			...base,
			hiddenOnly: false,
			localNode: true,
			rpcMirrors: rpc
		});
		const at = (u: string) => s.findIndex((x) => x.url.includes(u));
		expect(at(RPC_ONION)).toBeGreaterThan(at(ONION));
		expect(at(RPC_ONION)).toBeGreaterThan(s.findIndex((x) => x.transport === 'kubo'));
		expect(at(RPC_ONION)).toBeLessThan(s.findIndex((x) => x.transport === 'clearnet'));
	});
});

describe('fetching through the IPFS node (a stand-in ipfs)', () => {
	/** `ipfs` is `body` (bash); runuser just runs what it is given. */
	async function fetchWith(
		body: string,
		stallMs: number
	): Promise<{ ok: boolean; ms: number; got: string; stalled: boolean }> {
		const d = mkdtempSync(join(tmpdir(), 'kubo-fetch-'));
		const PATH = process.env.PATH;
		try {
			writeFileSync(join(d, 'runuser'), '#!/bin/bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
			writeFileSync(join(d, 'ipfs'), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
			process.env.PATH = `${d}:${PATH}`;
			let stalled = false;
			const t0 = Date.now();
			const ok = await fetchViaKubo(CID, join(d, 'out'), {
				user: 'ipfs',
				repo: '/var/lib/ipfs/.ipfs',
				runuser: true,
				maxBytes: 1000,
				stallMs,
				pollMs: 50,
				onStall: () => {
					stalled = true;
				}
			});
			return { ok, ms: Date.now() - t0, got: readFileSync(join(d, 'out'), 'utf8'), stalled };
		} finally {
			process.env.PATH = PATH;
			rmSync(d, { recursive: true, force: true });
		}
	}

	it('a whole file: accepted', async () => {
		const r = await fetchWith('printf snapshot', 2_000);
		expect(r).toMatchObject({ ok: true, got: 'snapshot', stalled: false });
	});

	it('a source that sends some bytes and then nothing is given up after the stall time, not kubo\u2019s 30 minutes', async () => {
		const r = await fetchWith('printf part; exec sleep 60', 500);
		expect(r.ok).toBe(false);
		expect(r.stalled).toBe(true);
		expect(r.ms).toBeLessThan(5_000);
	}, 20_000);

	it('a source still sending is never cut off', async () => {
		const r = await fetchWith('for i in 1 2 3 4 5 6; do printf x; sleep 0.2; done', 500);
		expect(r).toMatchObject({ ok: true, got: 'xxxxxx', stalled: false });
	}, 20_000);
});
