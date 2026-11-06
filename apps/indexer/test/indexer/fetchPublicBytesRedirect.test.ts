/**
 * fetchPublicBytes and redirects (v1.23.2).
 *
 * The guarded fetch never follows a redirect: it is how a hostile peer would
 * bounce the indexer to an address it did not check. The witness pictures'
 * fallback, the Blurt image proxy (imgp.blurt.blog), may answer a picture with
 * a redirect to its own resized copy, so a caller can now allow a few — and
 * only to https on the SAME origin, each hop checked and pinned like the first.
 * Only the network call is stubbed; every check here is the real code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent } from 'undici';

import { fetchPublicBytes } from '$indexer/federationProbe';

const PUBLIC = { address: '93.184.216.34', family: 4 as const };

function stubFetch(answers: Record<string, () => Response>) {
	const seen: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			seen.push(url);
			expect(init.redirect).toBe('manual');
			const a = answers[url];
			if (!a) throw new Error(`unexpected fetch ${url}`);
			return a();
		})
	);
	return seen;
}
const redirect = (to: string, status = 302) =>
	new Response(null, { status, headers: { location: to } });
const image = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchPublicBytes: redirects', () => {
	const A = 'https://imgp.blurt.blog/profileimage/khrom/64x64';
	const B = 'https://imgp.blurt.blog/64x64/https://img.blurt.world/khrom.png';

	it('by default a redirect is a failure, as always', async () => {
		const seen = stubFetch({ [A]: () => redirect(B) });
		await expect(fetchPublicBytes(A, { resolve: async () => PUBLIC })).rejects.toThrow('HTTP 302');
		expect(seen).toEqual([A]);
	});

	it('allowed: follows a same-origin redirect (relative or absolute) and returns its body', async () => {
		const seen = stubFetch({
			[A]: () => redirect('/64x64/https://img.blurt.world/khrom.png', 301),
			[B]: image
		});
		const resolved: string[] = [];
		const r = await fetchPublicBytes(A, {
			sameOriginRedirects: 2,
			resolve: async (h) => {
				resolved.push(h);
				return PUBLIC;
			}
		});
		expect([...r.bytes]).toEqual([1, 2, 3]);
		expect(seen).toEqual([A, B]);
		// Every hop is looked up and checked again.
		expect(resolved).toEqual(['imgp.blurt.blog', 'imgp.blurt.blog']);
	});

	it('never to another host, even with redirects allowed', async () => {
		const seen = stubFetch({ [A]: () => redirect('https://img.blurt.world/khrom.png') });
		await expect(
			fetchPublicBytes(A, { sameOriginRedirects: 2, resolve: async () => PUBLIC })
		).rejects.toThrow(/another origin/);
		expect(seen).toEqual([A]);
	});

	it('never down to plain http on the same host', async () => {
		stubFetch({ [A]: () => redirect('http://imgp.blurt.blog/64x64/x.png') });
		await expect(
			fetchPublicBytes(A, { sameOriginRedirects: 2, resolve: async () => PUBLIC })
		).rejects.toThrow(/another origin/);
	});

	it('never to an internal address the same name now points at (each hop re-checked)', async () => {
		stubFetch({ [A]: () => redirect(B), [B]: image });
		let n = 0;
		await expect(
			fetchPublicBytes(A, {
				sameOriginRedirects: 2,
				resolve: async () => {
					n++;
					if (n > 1) throw new Error('fetchJson: refusing to probe non-public host');
					return PUBLIC;
				}
			})
		).rejects.toThrow(/non-public/);
	});

	it('stops after the allowed number of hops', async () => {
		const C = 'https://imgp.blurt.blog/c';
		const seen = stubFetch({ [A]: () => redirect(B), [B]: () => redirect(C), [C]: image });
		await expect(
			fetchPublicBytes(A, { sameOriginRedirects: 1, resolve: async () => PUBLIC })
		).rejects.toThrow('HTTP 302');
		expect(seen).toEqual([A, B]);
	});

	it('a redirect without a Location is a failure', async () => {
		stubFetch({ [A]: () => new Response(null, { status: 302 }) });
		await expect(
			fetchPublicBytes(A, { sameOriginRedirects: 2, resolve: async () => PUBLIC })
		).rejects.toThrow('HTTP 302');
	});
});

describe('fetchPublicBytes: a redirect chain (review, v1.23.2)', () => {
	const A = 'https://imgp.blurt.blog/a';
	const delay = (ms: number, signal?: AbortSignal | null) =>
		new Promise<void>((res, rej) => {
			const t = setTimeout(res, ms);
			signal?.addEventListener('abort', () => {
				clearTimeout(t);
				rej(new Error('aborted'));
			});
		});

	it('has ONE deadline for the whole chain, not a fresh one per hop', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				await delay(80, init.signal);
				if (url.endsWith('/a')) return redirect('/b');
				if (url.endsWith('/b')) return redirect('/c');
				return image();
			})
		);
		const t0 = Date.now();
		await expect(
			fetchPublicBytes(A, { timeoutMs: 150, sameOriginRedirects: 2, resolve: async () => PUBLIC })
		).rejects.toThrow();
		expect(Date.now() - t0).toBeLessThan(220);
	});

	it("closes each hop's pinned connection before the next hop starts", async () => {
		const order: string[] = [];
		const spy = vi.spyOn(Agent.prototype, 'destroy').mockImplementation(async function () {
			order.push('destroy');
		} as never);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				order.push(`fetch ${url.slice(url.lastIndexOf('/'))}`);
				return url.endsWith('/a') ? redirect('/b') : image();
			})
		);
		try {
			await fetchPublicBytes(A, { sameOriginRedirects: 1, resolve: async () => PUBLIC });
		} finally {
			spy.mockRestore();
		}
		expect(order).toEqual(['fetch /a', 'destroy', 'fetch /b', 'destroy']);
	});

	it('never follows more than 5 hops, whatever the caller asks for', async () => {
		let n = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				n++;
				return redirect('/a');
			})
		);
		await expect(
			fetchPublicBytes(A, { sameOriginRedirects: Infinity, resolve: async () => PUBLIC })
		).rejects.toThrow('HTTP 302');
		expect(n).toBe(6);
	});
});
