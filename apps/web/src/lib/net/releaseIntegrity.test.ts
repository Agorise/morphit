/**
 * The in-page build-integrity check: the files the signed release lists are
 * fetched from this site and hashed against the signed manifest.
 *
 *   - It is decided by the running build and the signed release alone. What
 *     the operator's own /verify.json says (missing, or another version) does
 *     not switch it off.
 *   - A manifest entry is only ever fetched from this site: an entry that is
 *     not a same-origin path is refused without a request.
 *   - The result shown is a per-file count against the signed manifest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, newerThan } from './releaseTestVersions';
import { get } from 'svelte/store';

const RUNNING = RUNNING_VERSION;
const ORIGIN = 'https://morphit.example';

const GOOD: Record<string, string> = {
	'/index.html': '<!doctype html><title>Morphit</title>',
	'/service-worker.js': 'self.addEventListener("fetch",()=>{})',
	'/_app/immutable/entry/start.js': 'export const start = 1;'
};

async function sri(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let s = '';
	for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
	return `sha256-${btoa(s)}`;
}

async function signedManifest(): Promise<Record<string, string>> {
	const m: Record<string, string> = {};
	for (const [p, body] of Object.entries(GOOD)) m[p] = await sri(body);
	return m;
}

/** What this site serves, and every URL the page asked for. */
let served: Record<string, string>;
let requested: string[];
/** What the operator's /verify.json reports (null: missing / unreadable). */
let verifyJsonVersion: string | null;
let announced: string;

vi.mock('$lib/updates/servedVersion', () => ({
	readServedVersion: async () => verifyJsonVersion,
	SERVED_VERSION_REUSE_MS: 60_000
}));

vi.mock('$net/releaseFetch', async () => ({
	RELEASE_SIGNER_ACCOUNT: 'morphit',
	fetchVerifiedRelease: async () => ({
		ok: true,
		value: {
			payload: { version: announced, hash_manifest: await signedManifest() },
			trxId: 'ab'.repeat(20),
			blockNumber: 64_200_000,
			timestamp: '2026-10-02T01:00:00',
			signer: 'morphit'
		}
	})
}));

beforeEach(() => {
	served = { ...GOOD };
	requested = [];
	verifyJsonVersion = RUNNING;
	announced = RUNNING;
	vi.stubGlobal('location', {
		origin: ORIGIN,
		href: `${ORIGIN}/en`,
		protocol: 'https:',
		hostname: 'morphit.example',
		host: 'morphit.example'
	});
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
		requested.push(url.href);
		if (url.origin !== ORIGIN) return new Response('beacon', { status: 200 });
		const body = served[url.pathname];
		return body === undefined
			? new Response('not found', { status: 404 })
			: new Response(body, { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function boot() {
	const store = await import('$stores/release');
	store.resetReleaseStore();
	await store.initRelease();
	return store;
}

describe('the build-integrity check cannot be switched off by /verify.json', () => {
	it('verify.json missing (404) and a served file changed: the change is reported', async () => {
		verifyJsonVersion = null;
		served['/_app/immutable/entry/start.js'] = 'export const start = "tampered";';
		const store = await boot();
		const a = get(store.assetCheck);
		expect(a.kind).toBe('mismatch');
		expect(a.kind === 'mismatch' && a.mismatches.map((m) => m.path)).toEqual([
			'/_app/immutable/entry/start.js'
		]);
	});

	it('verify.json naming another version does not skip the check either', async () => {
		verifyJsonVersion = newerThan();
		served['/index.html'] = '<!doctype html><script src="//evil.example/x.js"></script>';
		const store = await boot();
		expect(get(store.assetCheck).kind).toBe('mismatch');
	});

	it('the untouched build checks out', async () => {
		verifyJsonVersion = null;
		const store = await boot();
		expect(get(store.assetCheck).kind).toBe('ok');
	});

	it('running another version than the signed release: not checked (neutral), no file fetched', async () => {
		announced = newerThan();
		const store = await boot();
		expect(get(store.assetCheck).kind).toBe('not_checked');
		expect(get(store.tamperedAssets)).toEqual([]);
		expect(requested.filter((u) => !u.endsWith('/verify.json'))).toEqual([]);
	});
});

describe('the result shown is a per-file count against the signed manifest', () => {
	it('every signed file matches: N of N, N = the files the signed release lists', async () => {
		const store = await boot();
		const s = get(store.integritySummary);
		const signed = Object.keys(await signedManifest()).length;
		expect(s).toEqual({ kind: 'checked', matched: signed, total: signed, version: RUNNING });
	});

	it('one changed file: N-1 of N', async () => {
		served['/service-worker.js'] = 'self.addEventListener("fetch",()=>{ /* tampered */ })';
		const store = await boot();
		const s = get(store.integritySummary);
		expect(s.kind === 'checked' && [s.matched, s.total]).toEqual([2, 3]);
	});

	it('another version running: says so, with both versions', async () => {
		announced = newerThan();
		const store = await boot();
		expect(get(store.integritySummary)).toEqual({
			kind: 'not_checked',
			running: RUNNING,
			announced: newerThan()
		});
	});
});

describe('a manifest entry is only ever fetched from this site', () => {
	it.each([
		'//evil.example/x',
		'https://evil.example/x',
		'/\\evil.example/x',
		'\\\\evil.example/x',
		'http:evil.example/x',
		'/x?beacon=1',
		''
	])('%j is refused without any request', async (key) => {
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		const r = await checkManifestAgainstRunningBundle({ [key]: await sri('x') });
		expect(requested).toEqual([]);
		expect(r.kind).not.toBe('ok');
	});

	it('a same-origin key without its leading slash is fetched from this site', async () => {
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		const r = await checkManifestAgainstRunningBundle({
			'index.html': await sri(GOOD['/index.html']!)
		});
		expect(r.kind).toBe('ok');
		expect(requested).toEqual([`${ORIGIN}/index.html`]);
	});

	it('a file served with different bytes is named as a mismatch', async () => {
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		served['/index.html'] = 'changed';
		const r = await checkManifestAgainstRunningBundle(await signedManifest());
		expect(r.kind).toBe('mismatch');
		expect(r.kind === 'mismatch' && r.mismatches.map((m) => m.path)).toEqual(['/index.html']);
	});

	it('also works where the browser withholds WebCrypto (plain-HTTP I2P)', async () => {
		const manifest = await signedManifest();
		vi.stubGlobal('crypto', {});
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		served['/index.html'] = 'changed';
		const r = await checkManifestAgainstRunningBundle(manifest);
		expect(r.kind === 'mismatch' && r.mismatches.map((m) => m.path)).toEqual(['/index.html']);
	});
});
