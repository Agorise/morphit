/**
 * The page start-up path of the build-integrity check while another build's
 * service worker runs the tab (vigilante.trading, 2026-10-30): the real
 * initRelease asks the controlling worker its build (CHECK_UPDATE →
 * RELEASE_INFO), says on the About page that it waits instead of "Loading…",
 * and checks everything once this build's worker takes over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { version as THIS_BUILD } from '$app/environment';
import { RUNNING_VERSION } from './releaseTestVersions';

const ORIGIN = 'https://site.example';
const FILES: Record<string, string> = {
	'/index.html': '<!doctype html><title>this release</title>',
	'/service-worker.js': 'self.version = "this release";',
	'/_app/immutable/entry/start.AbC123.js': 'export const start = 1;'
};
async function sri(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let s = '';
	for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
	return `sha256-${btoa(s)}`;
}

vi.mock('$lib/updates/servedVersion', () => ({
	readServedVersion: async () => null,
	SERVED_VERSION_REUSE_MS: 60_000
}));
vi.mock('$net/releaseFetch', async () => {
	const m: Record<string, string> = {};
	for (const [p, b] of Object.entries(FILES)) m[p] = await sri(b);
	return {
		RELEASE_SIGNER_ACCOUNT: 'morphit',
		fetchVerifiedRelease: async () => ({
			ok: true,
			value: {
				payload: { version: RUNNING_VERSION, hash_manifest: m },
				trxId: 'ab'.repeat(20),
				blockNumber: 64_200_000,
				timestamp: '2026-10-30T01:00:00',
				signer: 'morphit'
			}
		})
	};
});

/** A service-worker container whose controller answers CHECK_UPDATE with `build`. */
function workers(initial: string) {
	const target = new EventTarget();
	let build = initial;
	const controller = {
		postMessage: (m: { type?: string }) => {
			if (m?.type !== 'CHECK_UPDATE') return;
			queueMicrotask(() =>
				target.dispatchEvent(
					Object.assign(new Event('message'), { data: { type: 'RELEASE_INFO', installed: build } })
				)
			);
		}
	};
	return {
		container: Object.assign(target, { controller }),
		takeOver: (next: string) => {
			build = next;
			target.dispatchEvent(new Event('controllerchange'));
		}
	};
}

let asked: string[];
beforeEach(() => {
	asked = [];
	vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/en` });
	const data = new Map<string, string>();
	vi.stubGlobal('window', {
		localStorage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k)
		}
	});
	vi.stubGlobal('fetch', async (input: string | URL) => {
		const url = new URL(String(input), ORIGIN);
		asked.push(url.pathname);
		const body = FILES[url.pathname];
		return body === undefined ? new Response('', { status: 404 }) : new Response(body);
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('the integrity check at page start, while the previous build’s worker runs the tab', () => {
	it('says it waits (not "Loading…"), and checks everything once this build’s worker takes over', async () => {
		const sw = workers('an-older-build');
		vi.stubGlobal('navigator', { serviceWorker: sw.container });
		const store = await import('$stores/release');
		store.resetReleaseStore();
		await store.initRelease();
		expect(get(store.assetCheck)).toEqual({ kind: 'waiting_worker', worker: 'an-older-build' });
		expect(get(store.integritySummary)).toEqual({ kind: 'waiting_worker' });
		expect(asked).not.toContain('/index.html');

		sw.takeOver(THIS_BUILD);
		await vi.waitFor(() => expect(get(store.assetCheck).kind).toBe('ok'));
		expect(asked).toContain('/index.html');
	});
});
