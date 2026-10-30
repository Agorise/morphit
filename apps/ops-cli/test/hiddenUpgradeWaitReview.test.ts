/**
 * v1.21.6 review — the zero-clearnet wait (src/init/hiddenUpgradeWait.ts and the
 * loop in src/commands/upgrade.ts), held by behaviour:
 *
 *  - trust stays fail-closed across the retries: every try re-reads and
 *    re-verifies the record and the bytes, an older release found on a retry is
 *    never installed, "keep trying" still asks before installing, and a record
 *    signed by another key is an error even when an earlier read timed out;
 *  - what the operator is told is true: the spinner names the step it is in,
 *    "without a copy" counts only instances that answered without it, "kept
 *    trying for" is the time it really took, and a clock step does not stretch
 *    or cut the hour;
 *  - what other instances send cannot garble the terminal (wide names, escape
 *    sequences, split characters), and one peer that hangs does not hold back
 *    the others.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HiddenUpgradeWaitError } from '../src/init/hiddenUpgradeWait.ts';
import { fetchHiddenUpgrade } from '../src/init/hiddenUpgradeFetch.ts';
import { startDotsSpinner } from '../src/init/spinner.ts';
import {
	OFFICIAL_PUB,
	OTHER,
	fixtureReader,
	mergeFixtures,
	signedRelease,
	stubIndexer
} from './helpers/releaseChain.ts';

/** What every peer answers (each test sets it). */
let peer: (url: string) => Promise<Uint8Array> = async () => {
	throw new Error('no peer answer set');
};
let peerAsks = 0;
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async (url: string) => {
		peerAsks++;
		return peer(url);
	}
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');
const { tryResolveHiddenUpgrade, peerDisplayName } = await import(
	'../src/init/hiddenUpgradeResolve.ts'
);

const scratch = mkdtempSync(join(tmpdir(), 'morphit-hidden-wait-review-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const CID = `bafy${'a'.repeat(55)}`;
const onion = (c: string): string => `${c.repeat(56)}.onion`;

// ─── the resolver on its own ────────────────────────────────────────────────

const envFile = join(scratch, 'indexer.env');
writeFileSync(envFile, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of closers.splice(0)) await c();
});

const SHA = 'c8f6ec8b1cfe6a322cf9640bd83879076c5bdd7c0c2245347589e3ecb2372bc1';
const genuine = signedRelease('1.21.6', { source_sha256: SHA, ipfs_cid: CID });
const forged = signedRelease('1.21.6', { source_sha256: SHA, ipfs_cid: CID }, { key: OTHER });

async function resolveWith(opts: {
	chainRead: (m: string, p: readonly unknown[]) => Promise<unknown>;
	instances: unknown;
	events?: string[];
}) {
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
		onStatus: (l) => opts.events?.push(`status: ${l}`),
		onProgress: (l) => opts.events?.push(`line: ${l}`),
		anchorWait: {
			waitMs: 8 * 60_000,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			}
		}
	});
}

describe('trust: a forged record is never a wait', () => {
	it('a record signed by another key, seen while it keeps asking after reads that timed out, is a plain fail-closed error', async () => {
		// Read 1 times out (so it keeps asking), read 2 — the first of the wait —
		// times out too, and from then on the history names a forged record.
		let reads = 0;
		const forgedRead = fixtureReader(forged);
		const err = await resolveWith({
			chainRead: async (m, p) => {
				if (m === 'get_account_history' && reads++ < 2) {
					throw new Error("could not reach this node's own indexer: no answer within 60s");
				}
				return forgedRead(m, p);
			},
			instances: { instances: [] }
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(HiddenUpgradeWaitError);
		expect((err as Error).message).toMatch(/not signed by @morphit's pinned posting key/);
	});
	it('a record signed by another key is an error even when the node also lists a second record and withholds its block', async () => {
		// The second record's block is missing, which on its own reads as "not
		// listed yet": the forged one must still decide.
		const ghost = signedRelease(
			'1.21.6',
			{ source_sha256: SHA, ipfs_cid: CID },
			{ key: OTHER, blockNum: 70_000_001, seq: 43 }
		);
		const read = fixtureReader({
			history: [...forged.history, ...ghost.history],
			blocks: { ...forged.blocks }
		} as never);
		const err = await resolveWith({ chainRead: read, instances: { instances: [] } }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(HiddenUpgradeWaitError);
		expect((err as Error).message).toMatch(/not signed by @morphit's pinned posting key/);
	});
});

describe('a genuine release still waits for its block', () => {
	it('a second @morphit-signed record without a usable hash does not turn a lagging genuine block into an error', async () => {
		const lagging = signedRelease(
			'1.21.6',
			{ source_sha256: SHA, ipfs_cid: CID },
			{ blockNum: 70_000_002, seq: 44 }
		);
		const noHash = signedRelease('1.21.6', {}, { blockNum: 70_000_003, seq: 45 });
		const read = fixtureReader({
			history: [...lagging.history, ...noHash.history],
			blocks: { ...noHash.blocks } // the genuine record's block is not served yet
		} as never);
		const err = await resolveWith({ chainRead: read, instances: { instances: [] } }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(HiddenUpgradeWaitError);
	});
});

describe('the record wait runs on a steady clock', () => {
	it('a clock step back during the wait does not stretch it', async () => {
		const { findSignedReleaseAnchor } = await import('../src/lib/releaseAnchor.ts');
		let mono = 5_000;
		let wall = Date.UTC(2026, 9, 11, 12, 0, 0);
		vi.spyOn(performance, 'now').mockImplementation(() => mono);
		vi.spyOn(Date, 'now').mockImplementation(() => wall);
		let rounds = 0;
		try {
			const r = await findSignedReleaseAnchor(
				{
					sources: [
						async () => {
							rounds++;
							throw new Error('no answer within 60s');
						}
					],
					waitMs: 8 * 60_000,
					intervalMs: 10_000,
					sleep: async (ms) => {
						mono += ms;
						wall += ms;
						if (rounds === 1) wall -= 2 * 60 * 60_000; // Tor time sync steps it back
					}
				},
				{ tag: 'v1.21.6', signer: 'morphit', pinnedPubkey: OFFICIAL_PUB, chainId: 'x' }
			);
			expect(r.ok).toBe(false);
			// 8 minutes at one read every 10 s: 48 reads, and the last one at the
			// deadline — not two more hours of them.
			expect(rounds).toBeLessThanOrEqual(49);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('what the spinner says', () => {
	it('once the record is found, the spinner no longer says it is reading the record', async () => {
		const events: string[] = [];
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		await resolveWith({
			chainRead: fixtureReader(genuine),
			instances: { instances: [{ name: 'Morphit', alt_networks: { tor: onion('p') } }] },
			events
		}).catch(() => undefined);
		const found = events.findIndex((e) => e.startsWith("line: ✓ Found @morphit's signed record"));
		expect(found).toBeGreaterThan(0);
		// The label on screen from "✓ Found" until the next status: the last
		// status given before that line, or a newer one given after it.
		const searching = events.findIndex((e) => e.startsWith('line: Searching the federation'));
		const shownWhileSearching = events
			.slice(0, searching)
			.filter((e) => e.startsWith('status: '))
			.pop();
		expect(shownWhileSearching).not.toMatch(/signed record/);
	});

	it('"without a copy" counts only instances that answered without it, not those that could not be reached', async () => {
		const events: string[] = [];
		peer = async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:9050');
		};
		await resolveWith({
			chainRead: fixtureReader(genuine),
			instances: {
				instances: ['a', 'b', 'c', 'd', 'e'].map((c) => ({
					name: `Peer ${c}`,
					alt_networks: { tor: onion(c) }
				}))
			},
			events
		}).catch(() => undefined);
		const statuses = events.filter((e) => e.startsWith('status: Searching'));
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.some((s) => /without a copy/.test(s))).toBe(false);
	});
});

describe('what other instances send', () => {
	it('a very long name of characters outside the BMP is cut whole (no half character)', () => {
		const name = peerDisplayName({ name: '\u{20000}'.repeat(45) });
		expect(name).not.toBeNull();
		// No lone surrogate (half of a character outside the BMP).
		expect(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name as string)
		).toBe(false);
	});

	function fakeTty(columns: number): { out: NodeJS.WriteStream; text: () => string } {
		let text = '';
		const out = {
			isTTY: true,
			columns,
			write: (s: string) => {
				text += s;
				return true;
			}
		} as unknown as NodeJS.WriteStream;
		return { out, text: () => text };
	}
	/** Display columns of a terminal line (wide East Asian characters take two). */
	function cols(line: string): number {
		let n = 0;
		for (const ch of line) {
			const c = ch.codePointAt(0) as number;
			const wide =
				(c >= 0x1100 && c <= 0x115f) ||
				(c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
				(c >= 0xac00 && c <= 0xd7a3) ||
				(c >= 0xf900 && c <= 0xfaff) ||
				(c >= 0xfe30 && c <= 0xfe4f) ||
				(c >= 0xff00 && c <= 0xff60) ||
				(c >= 0xffe0 && c <= 0xffe6) ||
				(c >= 0x20000 && c <= 0x3fffd);
			n += wide ? 2 : 1;
		}
		return n;
	}

	it('a name in a script with combining marks or joiners is shown whole, still without controls', () => {
		expect(peerDisplayName({ name: 'हिन्दी बाज़ार' })).toBe('हिन्दी बाज़ार');
		expect(peerDisplayName({ name: 'بازار\u200cمن' })).toBe('بازار\u200cمن');
		expect(peerDisplayName({ name: '\u001b[2Jهند\u202e\u0007ي' })).toBe('2Jهندي');
	});
	it('a spinner label with wide (CJK) characters never takes more than one terminal line', () => {
		vi.useFakeTimers();
		try {
			const { out, text } = fakeTty(60);
			const stop = startDotsSpinner(
				`0:05 · Searching the federation (Tor + I2P): asking ${'自由交易市场'.repeat(7)} (Tor) · 1/3 asked`,
				out
			);
			vi.advanceTimersByTime(200);
			stop();
			// eslint-disable-next-line no-control-regex
			const frames = text()
				.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
				.split('\r');
			for (const f of frames) expect(cols(f)).toBeLessThanOrEqual(60);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a spinner label carrying terminal escape sequences is drawn without them', () => {
		const { out, text } = fakeTty(200);
		const stop = startDotsSpinner(
			'asking \u001b]8;;http://evil\u0007click\u001b]8;;\u0007 \u001b[2J\u009b31m x‮.onion',
			out
		);
		stop();
		const drawn = text().replace('\u001b[?25l', '').replace('\r\u001b[K\u001b[?25h', '');
		expect(drawn).not.toMatch(/\u001b\]|\u001b\[2J|\u0007|\u009b|‮/);
		expect(drawn).toMatch(/asking/);
	});

	it('one peer that hangs does not hold back the peers after it', async () => {
		const good = new Uint8Array([7, 7, 7]);
		const gateways = ['a', 'b', 'c', 'd', 'e'].map((c) => `http://${onion(c)}`);
		const asked: string[] = [];
		const result = fetchHiddenUpgrade(
			{
				ipnsName: '',
				ipfsCid: CID,
				expectedSha256: sha(good),
				version: '1.21.6',
				path: 'x.tar.gz'
			},
			{
				peerGateways: gateways,
				sha256: (b) => sha(b),
				fetchTarball: (url, signal) => {
					asked.push(url);
					if (url.includes(onion('a'))) {
						// Answers nothing until it is told to stop (a stalled circuit).
						return new Promise((_, reject) =>
							signal.addEventListener('abort', () => reject(new Error('aborted')))
						);
					}
					if (url.includes(onion('e'))) return Promise.resolve(good);
					return Promise.reject(new Error(`hidden upgrade: HTTP 404 from ${url}`));
				}
			}
		);
		const outcome = await Promise.race([
			result.then((r) => r.peer),
			new Promise<string>((r) => setTimeout(() => r('still waiting on the hung peer'), 1_000))
		]);
		expect(outcome).toBe(gateways[4]);
	});
});

// ─── the whole upgrade (harness from upgradeHiddenWait.test.ts) ─────────────

let work = '';
let installDir = '';
let etcDir = '';
const saved = { ...process.env };

/** A slim release tarball for `tag`. */
function slimRelease(tag: string): Buffer {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag, commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	mkdirSync(join(tree, 'apps', 'web', 'build'), { recursive: true });
	writeFileSync(join(tree, 'apps', 'web', 'build', 'index.html'), '<html></html>');
	const out = join(scratch, `rel-${Math.random().toString(36).slice(2)}.tar.gz`);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return readFileSync(out);
}

const out = (): string =>
	(process.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
		.map((c) => String(c[0]))
		.join('');
const errOut = (): string =>
	(process.stderr.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
		.map((c) => String(c[0]))
		.join('');
const installed = (): string => readFileSync(join(installDir, 'release-info.json'), 'utf8');

describe('the whole zero-clearnet upgrade', () => {
	beforeEach(() => {
		work = mkdtempSync(join(scratch, 'run-'));
		installDir = join(work, 'morphit');
		etcDir = join(work, 'etc');
		mkdirSync(etcDir);
		mkdirSync(join(installDir, 'apps', 'ops-cli'), { recursive: true });
		writeFileSync(
			join(installDir, 'release-info.json'),
			JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
		);
		writeFileSync(
			join(etcDir, 'indexer.env'),
			'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:1\n'
		);
		const bin = join(work, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
		process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
		process.env.MORPHIT_INSTALL_DIR = installDir;
		process.env.MORPHIT_ETC_DIR = etcDir;
		process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
		process.env.MORPHIT_WEB_ROOT = join(work, 'www');
		process.env.MORPHIT_SYSTEMD_DIR = join(work, 'systemd');
		process.env.MORPHIT_HELPER_DIR = join(work, 'helpers');
		peerAsks = 0;
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

	/** One upgrade run. `release` and `chain` are read at every request, so a
	 *  test may change them between tries. */
	async function upgrade(o: {
		release: { version: string; distribution: Record<string, unknown> };
		chainRead: (m: string, p: readonly unknown[]) => Promise<unknown>;
		hiddenWait: Record<string, unknown>;
		flags?: Record<string, string>;
		clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
		healsWhenUpToDate?: () => Promise<number>;
	}): Promise<number> {
		const idx = await stubIndexer({
			release: o.release,
			instances: { instances: [{ name: 'Morphit', alt_networks: { tor: onion('p') } }] }
		});
		let t = 0;
		const clock = o.clock ?? {
			now: () => t,
			sleep: async (ms: number) => void (t += ms)
		};
		try {
			return await runUpgrade({
				flags: o.flags ?? {},
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
				trust: { postingPubkey: OFFICIAL_PUB, chainRead: o.chainRead },
				anchorWait: clock,
				hiddenWait: { ...clock, ...o.hiddenWait },
				...(o.healsWhenUpToDate !== undefined ? { healsWhenUpToDate: o.healsWhenUpToDate } : {})
			} as never);
		} finally {
			await idx.close();
		}
	}

	it('every try verifies afresh: a record forged after the first try is refused, even though peers now serve the bytes', async () => {
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		let chain = fixtureReader(signedRelease('1.18.0', dist));
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: (m, p) => chain(m, p),
			hiddenWait: {
				interactive: true,
				ask: async () => {
					chain = fixtureReader(signedRelease('1.18.0', dist, { key: OTHER }));
					peer = async () => new Uint8Array(bytes);
					return 'retry';
				}
			}
		});
		expect(code).toBe(5);
		expect(errOut()).toMatch(/not signed by @morphit's pinned posting key/);
		expect(out()).not.toMatch(/Integrity verified/);
		expect(installed()).toMatch(/v1\.17\.15/);
	});

	it('a retry that finds an OLDER release (the indexer moved back) never installs it', async () => {
		const newer = slimRelease('v1.18.0');
		const older = slimRelease('v1.17.0');
		const release = {
			version: '1.18.0',
			distribution: { source_sha256: sha(newer), ipfs_cid: CID } as Record<string, unknown>
		};
		const chain = fixtureReader(
			mergeFixtures(
				signedRelease('1.18.0', release.distribution),
				signedRelease(
					'1.17.0',
					{ source_sha256: sha(older), ipfs_cid: CID },
					{ blockNum: 69_000_000, seq: 41 }
				)
			)
		);
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		let heals = 0;
		const code = await upgrade({
			release,
			chainRead: chain,
			hiddenWait: {
				interactive: true,
				ask: async () => {
					release.version = '1.17.0';
					release.distribution = { source_sha256: sha(older), ipfs_cid: CID };
					peer = async () => new Uint8Array(older);
					return 'retry';
				}
			},
			healsWhenUpToDate: async () => {
				heals++;
				return 0;
			}
		});
		expect(out()).toMatch(/✓ Got v1\.17\.0/); // it was fetched and verified...
		expect(out()).toMatch(/older than this install, so nothing was changed/); // ...and not installed
		expect(out()).not.toMatch(/Apply upgrade|Integrity verified/);
		expect(heals).toBe(1);
		expect(code).toBe(0);
		expect(installed()).toMatch(/v1\.17\.15/);
	});

	it('"keep trying by itself" that finds the release still asks before installing', async () => {
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		let t = 0;
		let sleeps = 0;
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: fixtureReader(signedRelease('1.18.0', dist)),
			clock: {
				now: () => t,
				sleep: async (ms) => {
					t += ms;
					// Ten minutes into "keep trying", an instance has upgraded.
					if (++sleeps === 2) peer = async () => new Uint8Array(bytes);
				}
			},
			hiddenWait: { interactive: true, ask: async () => 'keep-trying' }
		});
		expect(out()).toMatch(/✓ Got v1\.18\.0 from Morphit/);
		expect(out()).toMatch(/Apply upgrade from v1\.17\.15 to v1\.18\.0\?/);
		expect(out()).toMatch(/Not upgraded; nothing was changed/); // no answer on this test's stdin
		expect(code).toBe(2);
		expect(installed()).toMatch(/v1\.17\.15/);
	}, 40_000);

	it('a try after a wait first looks again at what this server runs: another upgrade may have changed it meanwhile', async () => {
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		let t = 0;
		let sleeps = 0;
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: fixtureReader(signedRelease('1.18.0', dist)),
			clock: {
				now: () => t,
				sleep: async (ms) => {
					t += ms;
					if (++sleeps === 1) {
						// Meanwhile, another session upgraded this server, and the
						// release can now be found.
						writeFileSync(
							join(installDir, 'release-info.json'),
							JSON.stringify({ tag: 'v1.18.0', commit: 'y', build_time: 'y', builder: 'y' })
						);
						peer = async () => new Uint8Array(bytes);
					}
				}
			},
			hiddenWait: { interactive: true, ask: async () => 'keep-trying' }
		});
		expect(out()).not.toMatch(/Apply upgrade from v1\.17\.15/);
		expect(out()).toMatch(/This server now runs v1\.18\.0/);
		expect(code).toBe(5);
	}, 40_000);

	it('another session upgrades the server DURING a try (its record wait can run 8 minutes): no "upgrade from" the old version', async () => {
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		peer = async () => new Uint8Array(bytes);
		const chain = fixtureReader(signedRelease('1.18.0', dist));
		let reads = 0;
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: async (m, p) => {
				if (m === 'get_account_history' && reads++ < 2) {
					if (reads === 2) {
						// Meanwhile, another session installs v1.18.0.
						writeFileSync(
							join(installDir, 'release-info.json'),
							JSON.stringify({ tag: 'v1.18.0', commit: 'y', build_time: 'y', builder: 'y' })
						);
					}
					throw new Error("could not reach this node's own indexer: no answer within 60s");
				}
				return chain(m, p);
			},
			hiddenWait: { interactive: true, ask: async () => 'retry' }
		});
		expect(out()).not.toMatch(/Apply upgrade from v1\.17\.15/);
		expect(out()).toMatch(/This server now runs v1\.18\.0/);
		expect(code).toBe(5);
	}, 40_000);

	it('a peer that serves a different file on every try: never installed, named as such', async () => {
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		peer = async () => new Uint8Array(slimRelease('v1.18.0-evil'));
		const answers = ['retry', 'later'];
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: fixtureReader(signedRelease('1.18.0', dist)),
			hiddenWait: { interactive: true, ask: async () => answers.shift() }
		});
		expect(code).toBe(5);
		expect(out()).toMatch(/Morphit \(Tor\): offered a file that does not match the signed record/);
		expect(out()).not.toMatch(/Integrity verified/);
		expect(installed()).toMatch(/v1\.17\.15/);
	});

	it('"kept trying for" is the time it really took (each try can take minutes)', async () => {
		let t = 0;
		const asked: number[] = [];
		const answers = ['keep-trying', 'later'];
		const code = await upgrade({
			release: { version: '1.18.0', distribution: { source_sha256: SHA, ipfs_cid: CID } },
			// The record never comes: each try reads for its full 8 minutes.
			chainRead: async () => {
				throw new Error("could not reach this node's own indexer: no answer within 60s");
			},
			clock: { now: () => t, sleep: async (ms) => void (t += ms) },
			hiddenWait: {
				interactive: true,
				ask: async () => {
					asked.push(t);
					return answers.shift();
				}
			}
		});
		expect(code).toBe(5);
		const span = (asked[1] as number) - (asked[0] as number);
		expect(span).toBeGreaterThan(60 * 60_000);
		const m = /Kept trying for (\d+) min (\d+) s/.exec(out());
		expect(m).not.toBeNull();
		const said = Number(m![1]) * 60_000 + Number(m![2]) * 1000;
		expect(said).toBe(span);
	});

	it('a clock step (Tor time sync) neither stretches nor cuts the hour of "keep trying"', async () => {
		// Wall clock and monotonic clock, both driven by the test's sleeps; the
		// wall clock is stepped back two hours during the first pause.
		let mono = 1_000_000;
		let wall = Date.UTC(2026, 9, 11, 12, 0, 0);
		vi.spyOn(performance, 'now').mockImplementation(() => mono);
		vi.spyOn(Date, 'now').mockImplementation(() => wall);
		let sleeps = 0;
		const bytes = slimRelease('v1.18.0');
		const dist = { source_sha256: sha(bytes), ipfs_cid: CID };
		peer = async (url) => {
			throw new Error(`hidden upgrade: HTTP 404 from ${url}`);
		};
		const answers = ['keep-trying', 'later'];
		const code = await upgrade({
			release: { version: '1.18.0', distribution: dist },
			chainRead: fixtureReader(signedRelease('1.18.0', dist)),
			clock: {},
			hiddenWait: {
				interactive: true,
				ask: async () => answers.shift(),
				sleep: async (ms: number) => {
					mono += ms;
					wall += ms;
					if (++sleeps === 1) wall -= 2 * 60 * 60_000;
				}
			}
		});
		expect(code).toBe(5);
		// The first search, then a try every 5 minutes for an hour (as without a step).
		expect(peerAsks).toBe(13);
	});
});
