/**
 * The build-integrity check never judges a stored copy of another release
 * (vigilante.trading, 2026-10-30): the site served the signed v1.21.18 files
 * byte for byte, yet the owner's browser showed the red "Build integrity check
 * failed" until he cleared the site's data.
 *
 *   1. The files whose name does not change with their bytes (index.html, the
 *      service worker) are asked for with cache 'no-cache'; hashed files are not.
 *   2. The service worker answers such a request from the server, its stored
 *      copy only offline.
 *   3. While another build's service worker answers the tab, nothing is judged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerServerCopyRequest, wantsServerCopy } from './dynamicPaths';

const ORIGIN = 'https://site.example';

async function sri(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let s = '';
	for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
	return `sha256-${btoa(s)}`;
}

const RELEASE: Record<string, string> = {
	'/index.html': '<!doctype html><title>this release</title>',
	'/service-worker.js': 'self.version = "this release";',
	'/_app/immutable/entry/start.AbC123.js': 'export const start = 1;'
};

let asked: { path: string; cache: RequestCache | undefined }[];

beforeEach(() => {
	asked = [];
	vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/en` });
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const path = new URL(String(input), ORIGIN).pathname;
		asked.push({ path, cache: init?.cache });
		const body = RELEASE[path];
		return body === undefined ? new Response('', { status: 404 }) : new Response(body);
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('1. the check asks for the server’s copy of the files named the same in every release', () => {
	it('index.html and the service worker with cache no-cache; hashed files as stored', async () => {
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		const manifest: Record<string, string> = {};
		for (const [p, b] of Object.entries(RELEASE)) manifest[p] = await sri(b);
		expect((await checkManifestAgainstRunningBundle(manifest)).kind).toBe('ok');
		expect(Object.fromEntries(asked.map((a) => [a.path, a.cache]))).toEqual({
			'/index.html': 'no-cache',
			'/service-worker.js': 'no-cache',
			'/_app/immutable/entry/start.AbC123.js': undefined
		});
	});
});

describe('2. the service worker answers such a request from the server', () => {
	const stored = new Map<string, Response>();
	const cache = {
		match: async (r: Request) => stored.get(new URL(r.url).pathname)?.clone(),
		put: async (r: Request, res: Response) => void stored.set(new URL(r.url).pathname, res)
	};
	beforeEach(() => stored.clear());

	it('only a request that asks for the server’s copy counts', () => {
		for (const c of ['no-cache', 'reload', 'no-store'] as const)
			expect(wantsServerCopy({ cache: c })).toBe(true);
		for (const c of ['default', 'force-cache', 'only-if-cached'] as const)
			expect(wantsServerCopy({ cache: c })).toBe(false);
	});

	it('a copy stored by an earlier release is not handed out while the server answers', async () => {
		stored.set('/index.html', new Response('earlier release'));
		const req = new Request(`${ORIGIN}/index.html`, { cache: 'no-cache' });
		const res = await answerServerCopyRequest(req, {
			cache,
			fetch: async () => new Response('this release')
		});
		expect(await res.text()).toBe('this release');
		expect(await stored.get('/index.html')?.text()).toBe('this release');
	});

	it('offline: the stored copy; nothing stored: 503', async () => {
		const down = async (): Promise<Response> => {
			throw new TypeError('offline');
		};
		const req = new Request(`${ORIGIN}/index.html`, { cache: 'no-cache' });
		expect((await answerServerCopyRequest(req, { cache, fetch: down })).status).toBe(503);
		stored.set('/index.html', new Response('kept'));
		expect(await (await answerServerCopyRequest(req, { cache, fetch: down })).text()).toBe('kept');
	});

	it('no-store: the server’s copy is not kept', async () => {
		const req = new Request(`${ORIGIN}/x.txt`, { cache: 'no-store' });
		await answerServerCopyRequest(req, { cache, fetch: async () => new Response('x') });
		expect(stored.has('/x.txt')).toBe(false);
	});
});

describe('3. nothing is judged while another build’s service worker answers the tab', () => {
	const announced = async (running: string) => {
		const m: Record<string, string> = {};
		for (const [p, b] of Object.entries(RELEASE)) m[p] = await sri(b);
		return { version: running, hash_manifest: m };
	};

	it('another build’s worker: only the files it cannot answer from its store are judged, then it waits', async () => {
		const { checkRunningBuild } = await import('$stores/release');
		const r = await checkRunningBuild(await announced('9.9.9'), '9.9.9', {
			own: async () => 'build-new',
			controlling: async () => 'build-old'
		});
		expect(r).toEqual({ kind: 'waiting_worker', worker: 'build-old' });
		expect(asked.map((a) => a.path).sort()).toEqual([
			'/_app/immutable/entry/start.AbC123.js',
			'/service-worker.js'
		]);
	});

	it('another build’s worker and a changed service worker on the server: still the alarm', async () => {
		const { checkRunningBuild } = await import('$stores/release');
		const signed = await announced('9.9.9');
		RELEASE['/service-worker.js'] = 'self.version = "changed";';
		try {
			const r = await checkRunningBuild(signed, '9.9.9', {
				own: async () => 'build-new',
				controlling: async () => 'build-old'
			});
			expect(r.kind).toBe('mismatch');
			expect(r.kind === 'mismatch' && r.mismatches.map((m) => m.path)).toEqual([
				'/service-worker.js'
			]);
		} finally {
			RELEASE['/service-worker.js'] = 'self.version = "this release";';
		}
	});

	it('another build’s worker and an index.html that differs: not judged until the takeover', async () => {
		const { checkRunningBuild } = await import('$stores/release');
		const signed = await announced('9.9.9');
		RELEASE['/index.html'] = '<!doctype html><title>stored by the old worker</title>';
		try {
			const r = await checkRunningBuild(signed, '9.9.9', {
				own: async () => 'build-new',
				controlling: async () => 'build-old'
			});
			expect(r.kind).toBe('waiting_worker');
		} finally {
			RELEASE['/index.html'] = '<!doctype html><title>this release</title>';
		}
	});

	it('this build’s own worker, or none: checked as before', async () => {
		const { checkRunningBuild } = await import('$stores/release');
		for (const controlling of [async () => 'build-new', async () => null]) {
			asked = [];
			const r = await checkRunningBuild(await announced('9.9.9'), '9.9.9', {
				own: async () => 'build-new',
				controlling
			});
			expect(r.kind).toBe('ok');
			expect(asked.length).toBe(3);
		}
	});
});
