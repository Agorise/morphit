// @vitest-environment jsdom
/**
 * Push that is off on purpose, read correctly by the browser.
 *
 * v1.18.0. A hidden-only relay turns Web Push off because every browser push
 * service is a clearnet host, and now says so: `503 {status:'push_disabled',
 * reason:'hidden_only'}`. The browser used to read any 503 as "the operator has
 * not enabled push yet". And a subscription taken while push worked (every
 * existing tor-only node, before upgrading) left the settings page showing
 * "subscribed" for something that will never arrive.
 *
 * Each test loads the module fresh: it caches the relay's key for the page's
 * life, and a cached key from one case would answer the next.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

type Reply = { status: number; body: unknown } | 'network-error';

async function load(reply: Reply) {
	vi.resetModules();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			if (reply === 'network-error') throw new TypeError('fetch failed');
			return new Response(JSON.stringify(reply.body), {
				status: reply.status,
				headers: { 'content-type': 'application/json' }
			});
		})
	);
	return import('./push');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('why push is unavailable, as the settings page asks it', () => {
	it('a hidden-only relay: off on purpose, and the page is told so', async () => {
		const m = await load({ status: 503, body: { status: 'push_disabled', reason: 'hidden_only' } });
		expect(await m.pushDeliveryUnavailable()).toBe('push_disabled_hidden_only');
	});

	it('an older relay, or off for the old reasons: plain push_disabled, as before', async () => {
		const m = await load({ status: 503, body: { status: 'push_disabled' } });
		expect(await m.pushDeliveryUnavailable()).toBe('push_disabled');
	});

	it('a 503 with no readable body is still plain push_disabled', async () => {
		vi.resetModules();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not json', { status: 503 }))
		);
		const m = await import('./push');
		expect(await m.pushDeliveryUnavailable()).toBe('push_disabled');
	});

	it('push working: nothing to report', async () => {
		const m = await load({ status: 200, body: { vapid_public_key: 'BKey' } });
		expect(await m.pushDeliveryUnavailable()).toBeNull();
	});

	/** An unreachable relay is not evidence that push is off. Reading it as
	 *  "off" would flip a working subscription to "not subscribed" on every
	 *  flaky connection. */
	it('a relay that cannot be reached right now says nothing either way', async () => {
		const m = await load('network-error');
		expect(await m.pushDeliveryUnavailable()).toBeNull();
	});
});
