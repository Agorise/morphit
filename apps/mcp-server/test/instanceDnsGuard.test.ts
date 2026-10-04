/**
 * A public-looking instance NAME that resolves to a private address is
 * refused, like a private literal is.
 *
 * getInstanceUrl() judged only the URL's hostname text, so a name pointing at
 * 127.0.0.1 / 10.x / 169.254.169.254 (a typo'd internal name, a hostile DNS
 * entry in the user's MCP config) was fetched. Every DNS answer is now checked
 * before the request; MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1 still opts in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('node:dns/promises', () => {
	const lookup = async () =>
		answers.list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
	return { lookup, default: { lookup } };
});

import { searchOrders } from '../src/tools/searchOrders';

const fetchSpy = vi.fn(
	async () =>
		new Response(JSON.stringify({ items: [], next_cursor: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		})
);

describe('instance host DNS check', () => {
	beforeEach(() => {
		process.env.MORPHIT_MCP_INSTANCE_URL = 'https://instance.example';
		delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		fetchSpy.mockClear();
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		['127.0.0.1'],
		['10.0.0.5'],
		['169.254.169.254'],
		['::1'],
		['93.184.216.34', '192.168.1.1']
	])('refuses a name resolving to %s and sends nothing', async (...addrs) => {
		answers.list = addrs;
		await expect(searchOrders({})).rejects.toThrow(/private/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fetches when every answer is public', async () => {
		answers.list = ['93.184.216.34'];
		await expect(searchOrders({})).resolves.toBeTruthy();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1 opts in', async () => {
		process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = '1';
		answers.list = ['127.0.0.1'];
		await expect(searchOrders({})).resolves.toBeTruthy();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
