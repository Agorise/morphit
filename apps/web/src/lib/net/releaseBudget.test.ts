/**
 * The release check's request budget, counted on the wire.
 *
 * Steady state: TWO small requests — one history read (the last 100 entries)
 * and one block read — at most once per 24 h per browser, however many page
 * loads and tabs. EVERY request goes to this site (`POST /v1/chain/agreed`):
 * the browser contacts no RPC node (v1.21.14 final review). The relay answers
 * only with what two RPC operators agree on; signature recovery against the
 * pinned key still keeps a forged release from passing.
 *
 * The real store → releaseFetch → chainRelay stack runs; only `fetch` is
 * replaced by the relay serving a small simulated chain
 * (./releaseTestInstance.ts) — any other URL fails, as the page's CSP makes it
 * fail — and the pinned key by a test key whose private half signs the
 * genuine releases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, olderThan } from './releaseTestVersions';
import { PrivateKey } from '@beblurt/dblurt';
import {
	AGREED_URL,
	ATTACKER_BTC,
	GENUINE_BTC,
	instance,
	releaseJson,
	releaseTx,
	serving,
	stubInstance,
	stubWindow
} from './releaseTestInstance';

const OFFICIAL = PrivateKey.fromSeed('morphit release budget test key');
const ATTACKER = PrivateKey.fromSeed('somebody else entirely');

vi.mock('$net/config', async (importOriginal) => {
	const real = (await importOriginal()) as Record<string, unknown>;
	return {
		...real,
		MORPHIT_OFFICIAL_POSTING_PUBKEY: PrivateKey.fromSeed('morphit release budget test key')
			.createPublic('BLT')
			.toString()
	};
});

const CURRENT = releaseTx(releaseJson(RUNNING_VERSION, GENUINE_BTC), OFFICIAL, 1);
const OLDER = releaseTx(releaseJson(olderThan(), GENUINE_BTC), OFFICIAL, 2);
const honest = serving(CURRENT, 64_000_000);
const calls = instance.calls;

beforeEach(() => {
	vi.resetModules();
	stubInstance();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('steady state: two small requests, both to this site', () => {
	it('one history read of the last 100 entries and one block read, nothing else, nowhere else', async () => {
		instance.answer = honest;
		const { fetchVerifiedRelease, RELEASE_CHECK_STEADY_STATE_REQUESTS } = await import(
			'$net/releaseFetch'
		);
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		expect(calls.map((c) => c.method)).toEqual(['get_account_history', 'get_block']);
		expect(calls).toHaveLength(RELEASE_CHECK_STEADY_STATE_REQUESTS);
		expect((calls[0]!.params as unknown[])[2]).toBe(100);
		expect(calls.every((c) => c.url === AGREED_URL)).toBe(true);
	});

	it('an older genuine release costs no extra request', async () => {
		instance.answer = serving(OLDER, 63_000_000);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok && r.value.payload.version).toBe(olderThan());
		expect(calls).toHaveLength(2);
	});

	it('no agreed answer: one failed request, then nothing', async () => {
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(!r.ok && r.error.kind).toBe('rpc_failed');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(AGREED_URL);
	});
});

describe('at most once per 24 h per browser: page loads and tabs', () => {
	function browser(opts: { locks: boolean }) {
		const data = new Map<string, string>();
		stubWindow({
			localStorage: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => void data.set(k, v),
				removeItem: (k: string) => void data.delete(k),
				get length() {
					return data.size;
				},
				key: (i: number) => [...data.keys()][i] ?? null
			}
		});
		// One lock manager for the whole browser, like the real one.
		const queue = new Map<string, Promise<unknown>>();
		const locks = {
			request<T>(name: string, cb: () => Promise<T>): Promise<T> {
				const prev = queue.get(name) ?? Promise.resolve();
				const run = prev.then(cb, cb);
				queue.set(
					name,
					run.catch(() => undefined)
				);
				return run;
			}
		};
		vi.stubGlobal('navigator', opts.locks ? { locks } : {});
	}
	/** A fresh tab: its own copy of every module, the browser's storage. */
	async function tab() {
		vi.resetModules();
		const store = await import('$stores/release');
		const { get } = await import('svelte/store');
		return {
			boot: async () => {
				await store.initRelease();
				return get(store.release).kind;
			}
		};
	}

	it('page loads within 24 h make no request; the next day costs two again', async () => {
		browser({ locks: true });
		instance.answer = honest;
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(2);
		expect(await (await tab()).boot()).toBe('ok');
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(2);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(4);
	});

	it('a check that got no answer is asked again after 12 hours, not the next day', async () => {
		browser({ locks: true });
		expect(await (await tab()).boot()).not.toBe('ok');
		expect(calls).toHaveLength(1);
		instance.answer = honest; // the instance's operators agree again
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 11 * 60 * 60 * 1000);
		expect(await (await tab()).boot()).not.toBe('ok'); // still remembered: twice a day at most
		expect(calls).toHaveLength(1);
		vi.setSystemTime(Date.now() + 61 * 60 * 1000);
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(3);
	});

	it('two tabs opened together share one check (Web Locks)', async () => {
		browser({ locks: true });
		instance.answer = honest;
		const [a, b] = [await tab(), await tab()];
		expect(await Promise.all([a.boot(), b.boot()])).toEqual(['ok', 'ok']);
		expect(calls).toHaveLength(2);
	});

	it('two tabs opened together share one check (no Web Locks: plain-http pages)', async () => {
		browser({ locks: false });
		instance.answer = honest;
		const [a, b] = [await tab(), await tab()];
		expect(await Promise.all([a.boot(), b.boot()])).toEqual(['ok', 'ok']);
		expect(calls).toHaveLength(2);
	});
});

describe('no source can pass a forged release', () => {
	it('an unsigned release: refused, nothing used', async () => {
		instance.answer = serving(
			releaseTx(releaseJson(RUNNING_VERSION, ATTACKER_BTC), null, 9),
			64_000_005
		);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(ATTACKER_BTC);
	});

	it('a release signed by another key, as two operators agree: pubkey_mismatch, nothing used', async () => {
		instance.answer = serving(
			releaseTx(releaseJson(RUNNING_VERSION, ATTACKER_BTC), ATTACKER, 9),
			64_000_005
		);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(!r.ok && r.error.kind).toBe('pubkey_mismatch');
		expect(JSON.stringify(r)).not.toContain(ATTACKER_BTC);
	});
});
