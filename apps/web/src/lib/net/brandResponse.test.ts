/**
 * The service worker's choice for a brand file: a `?fresh=1` read (the Blurt
 * post) never gets the stored copy, which may predate the site's branding.
 * Behaviour of the function the worker calls, plus that it calls it.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseBrandResponse, serveBrandFile, isBrandOverridablePath } from './dynamicPaths';

const ok = { ok: true, tag: 'network' };
const bad = { ok: false, tag: 'network-404' };
const cached = { ok: true, tag: 'cache' };

describe('service worker: which brand.json answer', () => {
	it('network first when it answers', () => {
		expect(chooseBrandResponse(ok, cached, true)).toBe(ok);
		expect(chooseBrandResponse(ok, cached, false)).toBe(ok);
	});
	it('a ?fresh=1 read with the network down: offline, never the stored copy', () => {
		expect(chooseBrandResponse(null, cached, true)).toBe('offline');
		expect(chooseBrandResponse(bad, cached, true)).toBe(bad);
	});
	it('an ordinary read with the network down: the stored copy', () => {
		expect(chooseBrandResponse(null, cached, false)).toBe(cached);
	});
	it('the worker decides with this function', () => {
		const sw = readFileSync(join(__dirname, '..', '..', 'service-worker.ts'), 'utf8');
		// (answerBrandRequest → serveBrandFile → chooseBrandResponse; the
		// worker itself cannot run under vitest — serviceWorkerBrand.test.ts
		// drives answerBrandRequest.)
		expect(sw).toMatch(/return answerBrandRequest\(req,/);
	});
	it('a server error: its own answer, except where the stored copy is kept (theme.css)', () => {
		expect(chooseBrandResponse(bad, cached, false)).toBe(bad);
		expect(chooseBrandResponse(bad, cached, false, true)).toBe(cached);
		expect(chooseBrandResponse(bad, cached, true, true)).toBe(bad);
		expect(chooseBrandResponse(null, cached, false)).toBe(cached);
	});
});

describe('service worker: a brand file is network-first (v1.21.8)', () => {
	type R = { ok: boolean; status: number; tag: string; clone(): R };
	const res = (tag: string, status = 200): R => ({
		ok: status >= 200 && status < 300,
		status,
		tag,
		clone() {
			return { ...this };
		}
	});
	const run = async (
		cached: R | undefined,
		network: () => Promise<R | null>,
		wantsFresh = false
	): Promise<{ got: R | 'offline'; stored: string[] }> => {
		const stored: string[] = [];
		const got = await serveBrandFile<R>(
			{
				match: async () => cached,
				network,
				store: async (f) => {
					stored.push(f.tag);
				}
			},
			wantsFresh
		);
		return { got, stored };
	};

	it("a copy stored before the site was branded is NOT what the page gets: the server's is", async () => {
		const { got, stored } = await run(res('morphit-logo (stored)'), async () =>
			res('vigilante-logo')
		);
		expect(got !== 'offline' && got.tag).toBe('vigilante-logo');
		expect(stored).toEqual(['vigilante-logo']);
	});
	it('offline (the network fails or times out): the stored copy', async () => {
		expect((await run(res('stored'), async () => null)).got).toMatchObject({ tag: 'stored' });
		expect(
			(
				await run(res('stored'), async () => {
					throw new Error('aborted');
				})
			).got
		).toMatchObject({ tag: 'stored' });
	});
	it('a server error never replaces the stored copy; the page gets the error (a stored copy may predate the branding)', async () => {
		const { got, stored } = await run(res('stored'), async () => res('error page', 502));
		expect(got).toMatchObject({ tag: 'error page', status: 502 });
		expect(stored).toEqual([]);
	});
	it('nothing stored and no network: offline (the worker answers 503)', async () => {
		expect((await run(undefined, async () => null)).got).toBe('offline');
	});
	it('a ?fresh=1 read never gets the stored copy', async () => {
		expect((await run(res('stored'), async () => null, true)).got).toBe('offline');
	});
	it('a store that fails still answers with the server copy', async () => {
		const got = await serveBrandFile<R>(
			{
				match: async () => res('stored'),
				network: async () => res('fresh'),
				store: async () => {
					throw new Error('quota');
				}
			},
			false
		);
		expect(got).toMatchObject({ tag: 'fresh' });
	});
	it('theme.css is a brand file (served this way)', () => {
		expect(isBrandOverridablePath('/brand/theme.css')).toBe(true);
	});
	// No deadline (see serveBrandFile): a slow server's answer is waited for,
	// because a stored copy from before the site was branded must never show.
	it('a slow network is waited for, even with a stored copy at hand', async () => {
		let answer!: (r: R) => void;
		let settled = false;
		vi.useFakeTimers();
		const pending = serveBrandFile<R>(
			{
				match: async () => res('morphit-logo (stored)'),
				network: () => new Promise<R>((r) => (answer = r)),
				store: async () => {}
			},
			false
		).then((r) => {
			settled = true;
			return r;
		});
		// However long the server takes (a full minute of timers here), the
		// stored copy is not handed out.
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			expect(settled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
		answer(res('vigilante-logo'));
		expect(await pending).toMatchObject({ tag: 'vigilante-logo' });
	});
});
