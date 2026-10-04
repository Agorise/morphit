/**
 * /v1/instance tells an anonymous visitor whether a node is zero-clearnet,
 * but not WHICH private legs it still lacks — that list is a map of where the
 * node still touches clearnet, for its operator only.
 */
import { describe, expect, it } from 'vitest';

import { instanceRoute } from '$api/instance';
import { fakeConfig } from '../testutils/context';

describe('/v1/instance and the missing clearnet legs', () => {
	const app = instanceRoute(fakeConfig());

	it('a public caller gets the verdict, not the list', async () => {
		const body = (await (await app.request('/')).json()) as Record<string, unknown>;
		expect(typeof body.clearnet_eliminated).toBe('boolean');
		expect('clearnet_eliminated_missing' in body).toBe(false);
	});

	it('a local caller gets the list, and it is never cached', async () => {
		const res = await app.request('/', { headers: { 'x-morphit-local-health': '1' } });
		const body = (await res.json()) as Record<string, unknown>;
		expect(Array.isArray(body.clearnet_eliminated_missing)).toBe(true);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});
