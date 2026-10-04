/**
 * What a fee explorer or a pricenode learns from the User-Agent.
 *
 * Third-party sources get the fixed role name the policy gives them
 * (`morphit-indexer/<role>`: explorerHttp.ts, priceFetchUtil.ts): never the
 * runtime's own `node`, never a version, never the contact URL that only Blurt
 * RPC operators are given (blurt/userAgent.ts). The source fetch enforces that
 * itself, so a caller that sets no UA, or the wrong one, cannot leak more.
 * Read on the wire: at the onion service behind the fake Tor, and at a clearnet
 * server where clearnet is allowed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { makeSourceFetch, SOURCE_USER_AGENT } from '$indexer/sourceFetch';
import { explorerInit, EXPLORER_USER_AGENT } from '$indexer/fee/explorerHttp';
import { morphitUserAgent } from '$blurt/userAgent';
import { INDEXER_VERSION } from '$api/health';
import { startFakeTor, type FakeTor } from '../testutils/fakeTor';

const ONION = `${'u'.repeat(56)}.onion`;
const POLICY = /^morphit-indexer\/[a-z][a-z-]*$/;

let tor: FakeTor | null = null;
let server: http.Server | null = null;
afterEach(async () => {
	await tor?.close();
	tor = null;
	server?.closeAllConnections?.();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = null;
});

/** Fetch once over the fake Tor and return the UA the onion received. */
async function uaSeenOverTor(init?: RequestInit): Promise<string | undefined> {
	let seen: string | undefined;
	tor = await startFakeTor({
		[ONION]: (req, res) => {
			seen = req.headers['user-agent'];
			res.writeHead(200, { 'content-type': 'text/plain' }).end('1');
		}
	});
	const f = makeSourceFetch({
		proxies: { torSocks: tor.socks, i2pHttpProxy: '', lokinet: false },
		clearnetAllowed: () => false
	});
	const res = await f(`http://${ONION}/api/blocks/tip/height`, init);
	expect(res.status).toBe(200);
	return seen;
}

describe('the source fetch sends only the policy User-Agent', () => {
	it('the default is itself a policy name: fixed, versionless', () => {
		expect(SOURCE_USER_AGENT).toMatch(POLICY);
	});

	it('over Tor, a caller that sets no UA sends the fixed one, not the runtime default', async () => {
		const ua = await uaSeenOverTor();
		expect(ua).toBe(SOURCE_USER_AGENT);
	});

	it("over Tor, the explorer verifier's role name goes through unchanged", async () => {
		const ua = await uaSeenOverTor(explorerInit({ method: 'GET', accept: 'text/plain' }, null));
		expect(ua).toBe(EXPLORER_USER_AGENT);
	});

	it('over Tor, a version or contact URL in the UA never reaches the source', async () => {
		const ua = await uaSeenOverTor({
			headers: { 'user-agent': morphitUserAgent(INDEXER_VERSION) }
		});
		expect(ua).toBe(SOURCE_USER_AGENT);
		expect(ua).not.toContain(INDEXER_VERSION);
		expect(ua).not.toContain('git.agorise.net');
	});

	it('over clearnet (where allowed), the same rule holds', async () => {
		const seen: (string | undefined)[] = [];
		server = http.createServer((req, res) => {
			seen.push(req.headers['user-agent']);
			res.writeHead(200).end('1');
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
		const port = (server.address() as AddressInfo).port;
		const f = makeSourceFetch({
			proxies: { torSocks: '', i2pHttpProxy: '', lokinet: false },
			clearnetAllowed: () => true
		});
		await f(`http://127.0.0.1:${port}/a`);
		await f(`http://127.0.0.1:${port}/b`, {
			headers: { 'user-agent': 'morphit-indexer/price-fetch' }
		});
		await f(`http://127.0.0.1:${port}/c`, { headers: [['User-Agent', 'curl/8.5.0']] });
		expect(seen).toEqual([SOURCE_USER_AGENT, 'morphit-indexer/price-fetch', SOURCE_USER_AGENT]);
	});
});
