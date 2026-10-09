/**
 * The main menu's "is there a newer release?" check.
 *
 * 2026-10-08, morphit.io: the menu said "(couldn't check for updates — network)"
 * while v1.21.2 was published and @morphit's record of it was already on chain.
 * It asked only git.agorise.net, for 2.5 s; the upgrade, asking the same URL
 * for 30 s a moment later, found v1.21.2 at once. An admin who opens the menu
 * now and then would read that as "nothing to do" and stay behind.
 *
 * Now the menu also reads the on-chain release record from this node's own
 * indexer (on the box), gives the code host longer, says "couldn't check" only
 * when every source failed, and turns the braille spinner while it waits.
 *
 * These drive the real gatherMenuAnnotations() and itemSuffix() with fetch
 * replaced: the node's own indexer and git.agorise.net are both stand-ins, and
 * any other address is refused and recorded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherMenuAnnotations, newestTag } from '../src/lib/menuAnnotations.ts';
import { itemSuffix, itemEmphasis } from '../src/commands/mainMenu.ts';
import { startDotsSpinner } from '../src/init/spinner.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** This node's indexer, its listener taken as proven (the /proc check is
 *  exercised in the last test). */
const LOCAL = {
	bases: [`http://127.0.0.1:18581`],
	verifyListener: () => ({ kind: 'verified', how: 'override' }) as const
};

const INDEXER_PORT = 18_581;
const realFetch = globalThis.fetch;

let root: string;
let installDir: string;
/** What the code host does when asked. */
let forge: (signal: AbortSignal | undefined) => Promise<Response>;
/** What this node's own indexer says /v1/release is (null: it does not answer). */
let onchain: string | null;
let elsewhere: string[];
let events: string[];

const json = (b: unknown): Response =>
	new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

function writeIndexerEnv(clearnetPool: string | null, port = INDEXER_PORT): void {
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	writeFileSync(
		join(root, 'etc', 'morphit', 'indexer.env'),
		(clearnetPool === null ? '' : `MORPHIT_INDEXER_RPC_ENDPOINTS=${clearnetPool}\n`) +
			'MORPHIT_INDEXER_LISTEN_HOST=127.0.0.1\n' +
			`MORPHIT_INDEXER_LISTEN_PORT=${port}\n`
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-menu-check-'));
	installDir = join(root, 'opt', 'morphit');
	mkdirSync(installDir, { recursive: true });
	writeFileSync(join(installDir, 'release-info.json'), JSON.stringify({ tag: 'v1.21.1' }));
	process.env.MORPHIT_ENV_ROOT = root;
	process.env.MORPHIT_INSTALL_DIR = installDir;
	writeIndexerEnv('https://rpc.example.invalid');
	onchain = null;
	elsewhere = [];
	events = [];
	forge = async () => {
		throw new TypeError('fetch failed');
	};
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => {
		const url = new URL(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		);
		if (url.host === `127.0.0.1:${INDEXER_PORT}` && url.pathname === '/v1/release') {
			if (onchain === null) throw new TypeError('fetch failed');
			return json({ version: onchain, distribution: null });
		}
		if (url.host === 'git.agorise.net') {
			events.push('code host asked');
			const r = await forge(init?.signal ?? undefined);
			events.push('code host answered');
			return r;
		}
		elsewhere.push(url.href);
		throw new TypeError('fetch failed');
	}) as typeof fetch;
});

afterEach(() => {
	vi.useRealTimers();
	globalThis.fetch = realFetch;
	delete process.env.MORPHIT_ENV_ROOT;
	delete process.env.MORPHIT_INSTALL_DIR;
	rmSync(root, { recursive: true, force: true });
});

const recordingSpinner = (label: string): (() => void) => {
	events.push(`spinner: ${label}`);
	return () => void events.push('spinner stopped');
};

/** The code host answers only when released; an abort rejects it, as fetch does. */
function heldCodeHost(): { release: (tag: string) => void } {
	let release: (tag: string) => void = () => undefined;
	forge = (signal) =>
		new Promise<Response>((resolve, reject) => {
			release = (tag) => resolve(json({ tag_name: tag }));
			signal?.addEventListener('abort', () =>
				reject(new DOMException('This operation was aborted', 'AbortError'))
			);
		});
	return { release: (tag) => release(tag) };
}

describe('the menu update check', () => {
	it("the code host does not answer, the on-chain record names a newer release: 'update available', not 'couldn't check'", async () => {
		onchain = '1.21.2';
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBe('v1.21.2');
		const suffix = itemSuffix('upgrade', ann);
		expect(suffix).toMatch(/update available/);
		expect(suffix).not.toMatch(/couldn.t check/);
		expect(elsewhere).toEqual([]);
	});

	it('a code host slower than the old 2.5 s limit is still waited for (with the spinner turning)', async () => {
		onchain = null;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const host = heldCodeHost();
		const pending = gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(events, 'the code host was given up on before 5 s').not.toContain('spinner stopped');
		host.release('v1.21.3');
		const ann = await pending;
		expect(ann.latestVersion).toBe('v1.21.3');
		expect(itemSuffix('upgrade', ann)).toMatch(/update available/);
	});

	it('when the on-chain record answers, it decides and the code host is not asked', async () => {
		// What installs is what the record names (an unsigned release installs
		// only by its hash there), so the menu offers exactly that, and the code
		// host is not told about this server each time the menu opens.
		onchain = '1.21.2';
		forge = async () => json({ tag_name: 'v1.21.3' });
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBe('v1.21.2');
		expect(events).not.toContain('code host asked');
	});

	it('the code host is asked only when the record does not answer', async () => {
		forge = async () => json({ tag_name: 'v1.21.3' });
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBe('v1.21.3');
		expect(events).toContain('code host asked');
	});

	it('a code host that does not answer is asked once, not twice', async () => {
		await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(events.filter((e) => e === 'code host asked')).toHaveLength(1);
	});

	it('only a host that says it has no stable release (404) is asked for the newest of any kind', async () => {
		let n = 0;
		forge = async () =>
			++n === 1
				? new Response('{"message":"not found"}', { status: 404 })
				: json([{ tag_name: 'v1.22.0-beta1' }]);
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBe('v1.22.0-beta1');
		expect(events.filter((e) => e === 'code host asked')).toHaveLength(2);
	});

	it("says it couldn't check only when every source failed", async () => {
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBeNull();
		expect(itemSuffix('upgrade', ann)).toMatch(/couldn.t check for updates/);
	});

	it('a record that is not a version number is ignored', async () => {
		onchain = '9.9.9; rm -rf /';
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBeNull();
	});

	it('the spinner starts before anything is asked and stops once every answer is in', async () => {
		forge = async () => json({ tag_name: 'v1.21.2' });
		await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		const start = events.findIndex((e) => e.startsWith('spinner: '));
		expect(start, 'no spinner while checking').toBe(0);
		expect(events[0]).toMatch(/Checking for a newer Morphit release/);
		expect(events.indexOf('code host asked')).toBeGreaterThan(start);
		expect(events.lastIndexOf('spinner stopped')).toBeGreaterThan(
			events.indexOf('code host answered')
		);
	});

	it('by default the spinner is the braille one, drawn on the terminal and cleared after', async () => {
		const written: string[] = [];
		const tty = {
			isTTY: true,
			write: (s: string) => void written.push(s)
		} as unknown as NodeJS.WriteStream;
		onchain = '1.21.2';
		await gatherMenuAnnotations({ spinner: (l) => startDotsSpinner(l, tty), localIndexer: LOCAL });
		const out = written.join('');
		expect(out).toMatch(/[⠀-⣿] Checking for a newer Morphit release/);
		expect(out.endsWith('\r\u001b[K\u001b[?25h')).toBe(true);
	});

	it('a local listener that is not morphit-indexer.service is not believed (real /proc check)', async () => {
		// A socket of this test process, claiming a newer release: not in the
		// indexer's cgroup, so the listener proof refuses it.
		const impostor = createServer((_q, r) => {
			r.writeHead(200, { 'content-type': 'application/json' });
			r.end(JSON.stringify({ version: '9.9.9' }));
		});
		await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
		const port = (impostor.address() as AddressInfo).port;
		let asked = 0;
		const inner = globalThis.fetch;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (new URL(u).port === String(port)) {
				asked++;
				return realFetch(input, init);
			}
			return inner(input, init);
		}) as typeof fetch;
		try {
			const ann = await gatherMenuAnnotations({
				spinner: recordingSpinner,
				localIndexer: { bases: [`http://127.0.0.1:${port}`] }
			});
			expect(ann.latestVersion).toBeNull();
			expect(asked, 'an unproven listener was asked').toBe(0);
		} finally {
			await new Promise<void>((r) => impostor.close(() => r()));
		}
	});

	it('a hidden-only node asks only its own indexer, never git.agorise.net', async () => {
		writeIndexerEnv('');
		onchain = '1.21.2';
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(ann.latestVersion).toBe('v1.21.2');
		expect(events).not.toContain('code host asked');
		expect(elsewhere).toEqual([]);
	});

	it('a node whose empty clearnet pool is set only in morphit.config.env is hidden-only for the menu too', async () => {
		// The upgrade reads that layout as hidden-only; the menu read only
		// indexer.env, took a missing key as "clearnet" and asked git.agorise.net.
		writeIndexerEnv(null);
		writeFileSync(join(installDir, 'morphit.config.env'), 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
		forge = async () => json({ tag_name: 'v1.21.3' });
		const ann = await gatherMenuAnnotations({ spinner: recordingSpinner, localIndexer: LOCAL });
		expect(events).not.toContain('code host asked');
		expect(elsewhere).toEqual([]);
		expect(ann.latestVersion).toBeNull();
	});

	it('on a hidden-only node, a local listener that is not morphit-indexer.service is not believed', async () => {
		const impostor = createServer((_q, r) => {
			r.writeHead(200, { 'content-type': 'application/json' });
			r.end(JSON.stringify({ version: '99.0.0', tag: 'v99.0.0', distribution: null }));
		});
		await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
		const port = (impostor.address() as AddressInfo).port;
		writeIndexerEnv('', port);
		globalThis.fetch = realFetch;
		try {
			const ann = await gatherMenuAnnotations({
				spinner: recordingSpinner,
				localIndexer: { bases: [`http://127.0.0.1:${port}`] }
			});
			expect(ann.latestVersion).toBeNull();
		} finally {
			await new Promise<void>((r) => impostor.close(() => r()));
		}
	});
});

describe('which release the menu calls newer', () => {
	it('an installed release newer than the record is not "update available"', () => {
		const ann = {
			currentVersion: 'v1.22.0',
			latestVersion: 'v1.21.2',
			latestIsOffline: false,
			unresolvedFlags: null,
			relayBalanceStatus: null
		};
		expect(itemSuffix('upgrade', ann)).not.toMatch(/update available/);
		expect(itemEmphasis('upgrade', ann)).toBeNull();
		expect(itemSuffix('upgrade', { ...ann, latestVersion: 'v1.22.1' })).toMatch(/update available/);
	});

	it('prerelease numbers compare as numbers (rc.10 is newer than rc.9)', () => {
		expect(newestTag(['v1.22.0-rc.9', 'v1.22.0-rc.10'])).toBe('v1.22.0-rc.10');
		expect(newestTag(['v1.22.0-rc.10', 'v1.22.0-rc.9'])).toBe('v1.22.0-rc.10');
		expect(newestTag(['v1.22.0-rc.1', 'v1.22.0'])).toBe('v1.22.0');
		expect(newestTag(['v1.22.0-beta', 'v1.22.0-beta.2'])).toBe('v1.22.0-beta.2');
	});
});
