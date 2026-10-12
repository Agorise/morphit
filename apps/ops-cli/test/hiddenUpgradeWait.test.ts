/**
 * v1.21.6 — a zero-clearnet upgrade that cannot get the release YET is a wait,
 * not an error (src/init/hiddenUpgradeWait.ts).
 *
 * morphitlat, 2026-10-10: two upgrades in a row stopped with a red ✗ after one
 * 60-second read of @morphit's history through the node's own indexer ("no
 * answer within 60s"); the third, a minute later, went through. Now the read is
 * asked again for a while, and when the release is not reachable the operator
 * is told what was searched, what each instance answered, and what to do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	HiddenUpgradeWaitError,
	classifyPeerFailure,
	parseWaitChoice,
	peerLines,
	renderHiddenWait
} from '../src/init/hiddenUpgradeWait.ts';
import { fetchHiddenUpgrade, HiddenFetchError } from '../src/init/hiddenUpgradeFetch.ts';
import { OFFICIAL_PUB, fixtureReader, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

// The Tor/I2P fetcher: each test says what every peer answers.
let peerAnswer: (url: string) => Promise<Uint8Array> = async () => {
	throw new Error('no peer answer set');
};
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async (url: string) => peerAnswer(url)
}));

const SHA = 'c8f6ec8b1cfe6a322cf9640bd83879076c5bdd7c0c2245347589e3ecb2372bc1';
const CID = 'bafybeiegfyir3zryt3iosz7ysxikcki4vwtui35ykd4uf55zp4ww5uctki';
const B32 = 'eanad5snar27ky2tbqof3v7lw7tjge3hslv3z4ekfyzry5fvrjnq.b32.i2p';
const ONION = 'ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion';
const B32_2 = 'rl2r63u6c62konfeuoumkjq37do6e6acpil7otngijras7u7vbpa.b32.i2p';

const scratch = mkdtempSync(join(tmpdir(), 'morphit-hidden-wait-'));
const envFile = join(scratch, 'indexer.env');
writeFileSync(envFile, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of closers.splice(0)) await c();
});

async function resolveWith(opts: {
	chainRead: (m: string, p: readonly unknown[]) => Promise<unknown>;
	instances: unknown;
	status?: string[];
	lines?: string[];
}) {
	const { tryResolveHiddenUpgrade } = await import('../src/init/hiddenUpgradeResolve.ts');
	const stub = await stubIndexer({
		release: { version: '1.21.6', distribution: { source_sha256: SHA, ipfs_cid: CID } },
		instances: opts.instances
	});
	closers.push(stub.close);
	let t = 0;
	return tryResolveHiddenUpgrade({
		configEnvPaths: [envFile],
		bases: [stub.base],
		verifyListener: () => ({ kind: 'verified', how: 'override' }),
		postingPubkey: OFFICIAL_PUB,
		chainRead: opts.chainRead,
		onStatus: (l) => opts.status?.push(l),
		onProgress: (l) => opts.lines?.push(l),
		anchorWait: {
			waitMs: 8 * 60_000,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			}
		}
	});
}

const chain = signedRelease('1.21.6', { source_sha256: SHA, ipfs_cid: CID });

describe('the record read over Tor/I2P', () => {
	it('a read with no answer in time is asked again (morphitlat, 2026-10-10), and says so', async () => {
		let reads = 0;
		const fixture = fixtureReader(chain);
		const status: string[] = [];
		const lines: string[] = [];
		peerAnswer = async () => {
			throw new Error('hidden upgrade: HTTP 404 from x');
		};
		const err = await resolveWith({
			chainRead: async (m, p) => {
				if (m === 'get_account_history' && reads++ < 2) {
					throw new Error("could not reach this node's own indexer: no answer within 60s");
				}
				return fixture(m, p);
			},
			instances: { instances: [{ name: 'Morphit', alt_networks: { i2p_b32: B32 } }] },
			status,
			lines
		}).catch((e: unknown) => e);
		// It got past the record (two failed reads, then the record): the wait is
		// now about the peers, not the record.
		expect(err).toBeInstanceOf(HiddenUpgradeWaitError);
		expect((err as HiddenUpgradeWaitError).stage).toBe('fetch');
		expect(reads).toBeGreaterThanOrEqual(3);
		expect(lines.some((l) => /had no answer from its Blurt nodes in time/.test(l))).toBe(true);
		expect(status.some((l) => /Still asking .* \(try 2\)/.test(l))).toBe(true);
		expect(lines.some((l) => /Found @morphit's signed record for v1\.21\.6/.test(l))).toBe(true);
	});

	it('a record that never comes: a wait at the record stage, not a bare error', async () => {
		const err = await resolveWith({
			chainRead: async () => {
				throw new Error('no answer within 60s');
			},
			instances: { instances: [] }
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HiddenUpgradeWaitError);
		const w = err as HiddenUpgradeWaitError;
		expect(w.stage).toBe('record');
		expect(w.recordNotListed).toBe(false);
		expect(w.searchedMs).toBeGreaterThanOrEqual(8 * 60_000 - 10_000);
		expect(w.message).toMatch(/no signed release record for v1\.21\.6/);
	});

	it('a record signed by another key is NOT a wait (fail-closed, plain error)', async () => {
		const { OTHER } = await import('./helpers/releaseChain.ts');
		const forged = signedRelease('1.21.6', { source_sha256: SHA, ipfs_cid: CID }, { key: OTHER });
		const err = await resolveWith({
			chainRead: fixtureReader(forged),
			instances: { instances: [] }
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(HiddenUpgradeWaitError);
	});
});

describe('the search of the federation', () => {
	it('no instance with a Tor/I2P address: a wait at the peers stage', async () => {
		const err = await resolveWith({
			chainRead: fixtureReader(chain),
			instances: { instances: [{ name: 'Clearnet only', alt_networks: {} }] }
		}).catch((e: unknown) => e);
		expect((err as HiddenUpgradeWaitError).stage).toBe('peers');
	});

	it('names what each instance answered (by its directory name and network)', async () => {
		peerAnswer = async (url) => {
			if (url.includes(B32)) throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
			if (url.includes(ONION)) throw new Error('hidden upgrade: tarball fetch timeout');
			throw new Error('connect ECONNREFUSED 127.0.0.1:4444');
		};
		const status: string[] = [];
		const err = await resolveWith({
			chainRead: fixtureReader(chain),
			instances: {
				instances: [
					{ name: 'Morphit', alt_networks: { i2p_b32: B32, tor: ONION } },
					{ operator_display_name: 'Libertad Latina', alt_networks: { i2p_b32: B32_2 } }
				]
			},
			status
		}).catch((e: unknown) => e);
		const w = err as HiddenUpgradeWaitError;
		expect(w.stage).toBe('fetch');
		const lines = peerLines(w.peers, '1.21.6');
		expect(lines).toContain(
			'Morphit: I2P — does not have v1.21.6 yet; Tor — did not answer in time'
		);
		expect(lines).toContain('Libertad Latina (I2P): could not be reached');
		expect(
			status.some((l) => /Searching the federation \(Tor \+ I2P\): asking .* · \d\/3 asked/.test(l))
		).toBe(true);
	});

	it('the fetch still reports per peer when called directly', async () => {
		const e = await fetchHiddenUpgrade(
			{ ipnsName: '', ipfsCid: CID, expectedSha256: SHA, version: '1.21.6', path: 'x.tar.gz' },
			{
				peerGateways: [`http://${B32}`],
				fetchTarball: async () => new Uint8Array([1, 2, 3]),
				sha256: () => '0'.repeat(64)
			}
		).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(HiddenFetchError);
		expect((e as HiddenFetchError).perPeer[0]?.reason).toMatch(/^sha_mismatch/);
		expect((e as Error).message).toMatch(/--from-file/); // the offline way out is still named
	});
});

describe('the explanation', () => {
	const fetchWait = new HiddenUpgradeWaitError('technical', {
		stage: 'fetch',
		version: '1.21.6',
		searchedMs: 185_000,
		peers: [{ name: 'Morphit', network: 'I2P', result: 'missing' }]
	});

	it('says it is a wait, what was searched, that nothing changed, and offers three choices', () => {
		const text = renderHiddenWait(fetchWait, { current: 'v1.21.5', interactive: true }).join('\n');
		expect(text).toMatch(/Not yet: no instance could share v1\.21\.6 over Tor\/I2P/);
		expect(text).toMatch(/For 3 min 05 s it searched the other Morphit instances/);
		expect(text).toMatch(/over both Tor and I2P/);
		expect(text).toMatch(/Morphit \(I2P\): does not have v1\.21\.6 yet/);
		expect(text).toMatch(/this server still runs v1\.21\.5 and keeps working/);
		expect(text).toMatch(/1\. Try again now/);
		expect(text).toMatch(/2\. Keep trying by itself/);
		expect(text).toMatch(
			/3\. Stop for now, and try again later — once more trusted instances have/
		);
		expect(text).not.toMatch(/✗/);
	});

	it('without a terminal: no question, just how to try again', () => {
		const text = renderHiddenWait(fetchWait, { current: 'v1.21.5', interactive: false }).join('\n');
		expect(text).not.toMatch(/What would you like to do/);
		expect(text).toMatch(/sudo morphit-ops upgrade/);
	});

	it('the record stage explains the indexer reads the chain over Tor/I2P', () => {
		const w = new HiddenUpgradeWaitError('t', {
			stage: 'record',
			version: '1.21.6',
			searchedMs: 480_000
		});
		const text = renderHiddenWait(w, { current: null, interactive: false }).join('\n');
		expect(text).toMatch(
			/reads the Blurt chain through its\s+own indexer, which asks Blurt nodes over Tor and I2P/
		);
		expect(text).toMatch(/For 8 min 00 s, the indexer's Blurt nodes did not answer in time/);
	});

	it('classifies peer answers in plain words', () => {
		expect(classifyPeerFailure('hidden upgrade: HTTP 404 from http://x')).toBe('missing');
		expect(classifyPeerFailure('hidden upgrade: HTTP 504 from http://x')).toBe('missing');
		expect(classifyPeerFailure('hidden upgrade: tarball fetch timeout')).toBe('no_answer');
		expect(classifyPeerFailure('This operation was aborted')).toBe('no_answer');
		expect(classifyPeerFailure('connect ECONNREFUSED 127.0.0.1:9050')).toBe('unreachable');
		expect(classifyPeerFailure('SOCKS5 reply: host unreachable')).toBe('unreachable');
		expect(classifyPeerFailure('sha_mismatch:http://x:abc')).toBe('mismatch');
		expect(classifyPeerFailure('something odd')).toBe('error');
	});

	it('reads the operator’s choice (Enter = try again now)', () => {
		expect(parseWaitChoice('')).toBe('retry');
		expect(parseWaitChoice('1')).toBe('retry');
		expect(parseWaitChoice(' 2 ')).toBe('keep-trying');
		expect(parseWaitChoice('3')).toBe('later');
		expect(parseWaitChoice('maybe')).toBeNull();
	});
});
