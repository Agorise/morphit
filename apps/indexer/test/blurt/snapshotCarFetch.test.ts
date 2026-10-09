/**
 * The snapshot mirror's fallback (src/blurt/snapshotCarFetch.ts): when kubo's
 * swarm cannot fetch the snapshot (morphitlat: 2 peers), it is fetched from a
 * peer's .onion / .b32.i2p as a CAR and imported under the same CID.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { carUrl, importCarWith, pinSnapshotFromPeers } from '../../src/blurt/snapshotCarFetch';
import { buildSnapshotSources } from '../../src/blurt/snapshotMirrors';

const CID = 'QmVs236Da4ER5DeSSkda7BXCLm6czEm4rYC9B92Qu32kv1';
const ONION = 'a'.repeat(56) + '.onion';
const I2P = 'c'.repeat(52) + '.b32.i2p';
const CAR = 'application/vnd.ipld.car; version=1; order=dfs; dups=n';

const sources = buildSnapshotSources({
	cid: CID,
	peers: [{ tor: ONION, i2p_b32: I2P }],
	publicGateways: ['https://ipfs.io'],
	localGateway: 'http://127.0.0.1:8082',
	hiddenOnly: true
});

function answer(status: number, type: string, body = 'car-bytes'): Response {
	return new Response(body, { status, headers: { 'content-type': type } });
}

describe('fetching the snapshot from a peer as a CAR', () => {
	it('asks for the trustless CAR', () => {
		expect(carUrl(`http://${ONION}/ipfs/${CID}`)).toBe(`http://${ONION}/ipfs/${CID}?format=car`);
	});

	it('the first peer that serves the CAR wins, and its bytes go to kubo under the CID', async () => {
		const asked: string[] = [];
		const imported: Array<[string, string]> = [];
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async (u) => (asked.push(u), answer(200, CAR)),
			importCar: (b, c) => (imported.push([Buffer.from(b).toString(), c]), true),
			say: () => undefined
		});
		expect(r).toEqual({ ok: true, from: expect.stringMatching(/^Tor peer/) });
		expect(asked).toEqual([`http://${ONION}/ipfs/${CID}?format=car`]);
		expect(imported).toEqual([['car-bytes', CID]]);
	});

	it('a peer that answers with a page, an error or a huge body is skipped for the next', async () => {
		const asked: string[] = [];
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async (u) => {
				asked.push(u);
				return u.includes('.onion') ? answer(200, 'text/html') : answer(200, CAR);
			},
			importCar: () => true,
			say: () => undefined
		});
		expect(r.ok).toBe(true);
		expect(asked.length).toBe(2);
		const big = await pinSnapshotFromPeers(sources, CID, {
			fetch: async () => answer(200, CAR, 'x'.repeat(50)),
			importCar: () => true,
			say: () => undefined,
			maxBytes: 10
		});
		expect(big.ok).toBe(false);
	});

	// v1.21.4 review (B4): with no content-length, the whole body was read into
	// memory before its size was checked; a peer could send without end.
	it('stops reading a body without a length as soon as it passes the limit', async () => {
		let pulled = 0;
		const endless = (): Response =>
			new Response(
				new ReadableStream({
					pull(c) {
						pulled++;
						if (pulled > 1000) c.close();
						else c.enqueue(new Uint8Array(1024));
					}
				}),
				{ status: 200, headers: { 'content-type': CAR } }
			);
		let imported = false;
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async () => endless(),
			importCar: () => ((imported = true), true),
			say: () => undefined,
			maxBytes: 10 * 1024
		});
		expect(r.ok).toBe(false);
		expect(imported).toBe(false);
		// Two sources, each read only a little past 10 kB.
		expect(pulled, 'the body was read far past the limit').toBeLessThan(40);
	});

	// v1.21.4 review: a peer's answer could redirect the mirror anywhere,
	// a clearnet or loopback address included.
	it('never follows a redirect', async () => {
		const inits: Array<RequestInit | undefined> = [];
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async (_u, init) => (
				inits.push(init),
				new Response('', { status: 302, headers: { location: 'http://127.0.0.1:5001/' } })
			),
			importCar: () => true,
			say: () => undefined
		});
		expect(r.ok).toBe(false);
		expect(inits.length).toBe(2);
		for (const i of inits) expect(i?.redirect).toBe('manual');
	});

	// v1.21.4 review: the fallback could run the mirror past its 30 minutes.
	it('asks no peer once too little of the run is left, and gives the import what is left', async () => {
		let t = 0;
		const said: string[] = [];
		const asked: string[] = [];
		const budgets: Array<number | undefined> = [];
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async (u) => (asked.push(u), (t += 4 * 60_000), answer(200, CAR)),
			importCar: (_b, _c, budget) => (budgets.push(budget), (t += 90_000), false),
			say: (m) => said.push(m),
			now: () => t,
			deadline: 6 * 60_000
		});
		expect(r.ok).toBe(false);
		// The first peer: 4 min fetch, then the import with the ~2 min left;
		// then under a minute is left, so the second is not asked.
		expect(asked.length).toBe(1);
		expect(budgets[0]).toBeLessThanOrEqual(2 * 60_000);
		expect(said.join('\n')).toMatch(/next run/);
	});

	it('says so when no peer address is known', async () => {
		const said: string[] = [];
		const none = buildSnapshotSources({
			cid: CID,
			peers: [],
			publicGateways: [],
			localGateway: null,
			hiddenOnly: true
		});
		await pinSnapshotFromPeers(none, CID, {
			fetch: async () => answer(200, CAR),
			importCar: () => true,
			say: (m) => said.push(m)
		});
		expect(said.join('\n')).toMatch(/no federation peer.*\.onion/i);
	});

	it('kubo refusing the import (bytes that are not that CID) is not a success', async () => {
		const r = await pinSnapshotFromPeers(sources, CID, {
			fetch: async () => answer(200, CAR),
			importCar: () => false,
			say: () => undefined
		});
		expect(r.ok).toBe(false);
	});

	it('never asks the local gateway or a clearnet source', async () => {
		const asked: string[] = [];
		const all = buildSnapshotSources({
			cid: CID,
			peers: [],
			publicGateways: ['https://ipfs.io'],
			localGateway: 'http://127.0.0.1:8082',
			hiddenOnly: false
		});
		const r = await pinSnapshotFromPeers(all, CID, {
			fetch: async (u) => (asked.push(u), answer(200, CAR)),
			importCar: () => true,
			say: () => undefined
		});
		expect(r.ok).toBe(false);
		expect(asked).toEqual([]);
	});
});

// v1.21.4 review (B5): `dag import --pin-roots=true` pinned whatever roots the
// PEER's CAR declared, so a hostile peer could leave its own content pinned
// (and served) on this box. Only the anchored CID may end up pinned.
describe('importing a CAR into kubo', () => {
	/** A kubo stand-in: a CAR here is "root=<cid>;blocks=<cid>,<cid>". */
	function fakeKubo() {
		const blocks = new Set<string>();
		const pins = new Set<string>();
		const run = (args: readonly string[]): string | null => {
			const [a, b] = args;
			if (a === 'dag' && b === 'import') {
				const text = readFileSync(args[args.length - 1]!, 'utf8');
				const root = /root=([^;]+)/.exec(text)?.[1] ?? '';
				for (const x of (/blocks=(.*)$/.exec(text)?.[1] ?? '').split(',')) blocks.add(x);
				if (!args.includes('--pin-roots=false')) pins.add(root);
				return '';
			}
			if (a === 'pin' && b === 'add') {
				const c = args[args.length - 1]!;
				if (!blocks.has(c)) return null;
				pins.add(c);
				return `pinned ${c} recursively`;
			}
			if (a === 'pin' && b === 'ls') {
				const c = args[args.length - 1]!;
				return pins.has(c) ? `${c} recursive` : null;
			}
			return null;
		};
		return { run, pins };
	}
	const car = (t: string) => new Uint8Array(Buffer.from(t));

	it("a CAR declaring someone else's root: only the anchored CID is pinned", async () => {
		const k = fakeKubo();
		expect(importCarWith(k.run, car(`root=EVIL;blocks=EVIL,${CID}`), CID)).toBe(true);
		expect([...k.pins]).toEqual([CID]);
	});

	it('a CAR without the anchored CID pins nothing', async () => {
		const k = fakeKubo();
		expect(importCarWith(k.run, car('root=EVIL;blocks=EVIL'), CID)).toBe(false);
		expect([...k.pins]).toEqual([]);
	});
});

describe('the mirror script uses the fallback', () => {
	it('when the swarm has no peers or cannot fetch, the peers are asked for the CAR before giving up', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const ts = (await import('typescript')).default;
		const file = join(__dirname, '..', '..', 'scripts', 'snapshot-mirror.ts');
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		let fallback = false;
		let noPeersReturns = false;
		const visit = (n: import('typescript').Node): void => {
			if (ts.isIfStatement(n)) {
				const cond = n.expression.getText(sf);
				const body = n.thenStatement.getText(sf);
				if (cond === '!pinned' && /pinSnapshotFromPeers\(/.test(body)) fallback = true;
				if (cond === 'peers === 0' && /\breturn\b/.test(body)) noPeersReturns = true;
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		expect(fallback, 'no CAR fallback when the swarm fails').toBe(true);
		expect(noPeersReturns, 'no swarm peers still gives up before asking the federation').toBe(
			false
		);
	});
});
