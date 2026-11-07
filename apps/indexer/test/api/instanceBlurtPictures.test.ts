/**
 * /v1/instance tells the pages whether this instance fetches Blurt profile
 * pictures (v1.23.3): never on a hidden-only instance, which must not reach
 * clearnet — there the page offers no "show pictures" switch at all.
 */
import { describe, expect, it, vi } from 'vitest';

const refused = vi.hoisted(() => ({ on: false }));
vi.mock('$indexer/hiddenServiceDispatcher', async (orig) => ({
	...((await orig()) as object),
	clearnetRefused: () => refused.on
}));

const { instanceRoute } = await import('$api/instance');
const { fakeConfig } = await import('../testutils/context');

describe('/v1/instance: blurt_pictures (v1.23.3)', () => {
	it('true where clearnet may be reached, false on a hidden-only instance', async () => {
		const app = instanceRoute(fakeConfig());
		refused.on = false;
		expect(
			((await (await app.request('/')).json()) as { blurt_pictures: boolean }).blurt_pictures
		).toBe(true);
		refused.on = true;
		expect(
			((await (await app.request('/')).json()) as { blurt_pictures: boolean }).blurt_pictures
		).toBe(false);
	});
});
