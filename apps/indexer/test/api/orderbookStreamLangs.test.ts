/**
 * The orderbook stream refuses a language filter with no valid code, as the
 * REST orderbook does (review C-1). Without the check the filter was dropped
 * and `?langs=EN` streamed every order, untagged ones included, to a caller
 * that thought it had filtered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { orderbookStreamRoute } from '../../src/api/orderbookStream';
import { _resetStreamCapsForTest } from '../../src/api/streamCaps';

const db = { query: async () => ({ rows: [], rowCount: 0 }) };
const poller = { getStatus: () => ({ indexedBlock: 1 }) };

async function status(qs: string): Promise<number> {
	const app = orderbookStreamRoute(db as never, poller as never, 'morphit');
	const res = await app.request(
		`/?${qs}`,
		{ headers: { 'x-real-ip': '203.0.113.9' } },
		{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
	);
	if (res.status === 200) await res.body?.cancel();
	return res.status;
}

describe('orderbook stream: language filter', () => {
	afterEach(() => _resetStreamCapsForTest());
	it.each(['langs=xx', 'langs=EN', 'langs=zh-cn', 'langs=,', "langs=es'%3B--"])(
		'%s → 400, like /v1/orderbook',
		async (qs) => {
			expect(await status(qs)).toBe(400);
		}
	);
	it.each(['langs=es', 'langs=es,xx', 'langs=zh-CN'])('%s → streams', async (qs) => {
		expect(await status(qs)).toBe(200);
	});
});
