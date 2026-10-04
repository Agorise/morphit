/**
 * The source fetch bounds every request itself. A caller that passes no
 * AbortSignal (or a slow one) must not be able to hang on an onion service
 * that accepts the connection and never answers — over Tor, or over clearnet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { makeSourceFetch } from '$indexer/sourceFetch';
import { startFakeTor, type FakeTor } from '../testutils/fakeTor';

const ONION = `${'s'.repeat(56)}.onion`;

let tor: FakeTor | null = null;
let silent: http.Server | null = null;
afterEach(async () => {
	await tor?.close();
	tor = null;
	silent?.closeAllConnections?.();
	await new Promise<void>((r) => (silent ? silent.close(() => r()) : r()));
	silent = null;
});

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
	Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))]);

describe('makeSourceFetch has its own request timeout', () => {
	it('an onion that never answers: the request fails on its own, with no caller signal', async () => {
		// The handler takes the request and never responds.
		tor = await startFakeTor({ [ONION]: () => undefined });
		const f = makeSourceFetch({
			proxies: { torSocks: tor.socks, i2pHttpProxy: '', lokinet: false },
			clearnetAllowed: () => false,
			requestTimeoutMs: 300
		});
		const r = await within(
			f(`http://${ONION}/api/blocks/tip/height`).then(
				() => 'answered',
				() => 'failed'
			),
			3000
		);
		expect(r, 'the request hung past its timeout').toBe('failed');
	});

	it('a clearnet source that never answers fails the same way (where clearnet is allowed)', async () => {
		silent = http.createServer(() => undefined);
		await new Promise<void>((r) => silent!.listen(0, '127.0.0.1', r));
		const port = (silent.address() as AddressInfo).port;
		const f = makeSourceFetch({
			proxies: { torSocks: '', i2pHttpProxy: '', lokinet: false },
			clearnetAllowed: () => true,
			requestTimeoutMs: 300
		});
		const r = await within(
			f(`http://127.0.0.1:${port}/x`).then(
				() => 'answered',
				() => 'failed'
			),
			3000
		);
		expect(r, 'the request hung past its timeout').toBe('failed');
	});
});
