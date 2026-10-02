/**
 * v1.20.3 — one /verify.json download serves both readers on page load: the
 * release check (is the served build the announced one?) and the update check
 * (is a newer build deployed?). Each used to fetch the ~80 KB file itself.
 */
import { describe, expect, it } from 'vitest';

import { createServedVersionReader } from './servedVersion';

const body = (v: string) => JSON.stringify({ morphit_version: v, files: {} });

describe('the shared served-version read', () => {
	it('two readers at once: one download', async () => {
		let n = 0;
		let release!: (r: Response) => void;
		const read = createServedVersionReader({
			fetchVerifyJson: () => {
				n++;
				return new Promise<Response>((r) => (release = r));
			},
			now: () => 0
		});
		const a = read();
		const b = read();
		while (n === 0) await Promise.resolve(); // the download starts a tick later
		release(new Response(body('1.20.3')));
		expect(await a).toBe('1.20.3');
		expect(await b).toBe('1.20.3');
		expect(n).toBe(1);
	});
	it('a read shortly after reuses the answer; a later one downloads again', async () => {
		let n = 0;
		let t = 0;
		const read = createServedVersionReader({
			fetchVerifyJson: async () => {
				n++;
				return new Response(body(`1.20.${n}`));
			},
			now: () => t
		});
		expect(await read()).toBe('1.20.1');
		t = 59_000;
		expect(await read({ maxAgeMs: 60_000 })).toBe('1.20.1');
		t = 61_000;
		expect(await read({ maxAgeMs: 60_000 })).toBe('1.20.2');
		// maxAgeMs 0 (the periodic poll): always fresh
		expect(await read({ maxAgeMs: 0 })).toBe('1.20.3');
		expect(n).toBe(3);
	});
	it('a fetcher that throws synchronously does not wedge later reads', async () => {
		let n = 0;
		const read = createServedVersionReader({
			fetchVerifyJson: () => {
				n++;
				if (n === 1) throw new Error('sync');
				return Promise.resolve(new Response(body('1.20.3')));
			},
			now: () => 0
		});
		expect(await read()).toBeNull();
		expect(await read()).toBe('1.20.3');
	});
	it('a failure is null and is not remembered', async () => {
		let n = 0;
		const read = createServedVersionReader({
			fetchVerifyJson: async () => {
				n++;
				if (n === 1) throw new Error('offline');
				if (n === 2) return new Response('nope', { status: 503 });
				return new Response(body('1.20.3'));
			},
			now: () => 0
		});
		expect(await read()).toBeNull();
		expect(await read()).toBeNull();
		expect(await read()).toBe('1.20.3');
	});
});
