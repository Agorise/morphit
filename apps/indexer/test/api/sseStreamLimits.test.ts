/**
 * the SSE streams.
 *
 * E3: a client that disconnected from /v1/orderbook/stream left its
 * provisional-bus listener subscribed forever (cancel() unsubscribed the
 * durable listener only). Every page view leaked one closure until restart,
 * and each provisional emit walked all of them.
 *
 * E4: the streams had no cap at all — no rate limit, no connection limit, and
 * over Tor the proxy in front cannot tell visitors apart — while each open
 * /v1/instances/stream ran its OWN full directory query every five seconds.
 *
 * Real routes, served through Hono; the database is a counting stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderbookStreamRoute } from '../../src/api/orderbookStream';
import { instancesStreamRoute } from '../../src/api/instancesStream';
import { orderbookEventBus } from '../../src/indexer/orderbookEventBus';
import { _setStreamCapsForTest, _resetStreamCapsForTest } from '../../src/api/streamCaps';

let queries = 0;
const db = {
	query: async () => {
		queries++;
		return { rows: [], rowCount: 0 };
	}
};
const poller = { getStatus: () => ({ indexedBlock: 1 }) };

/** Open a stream, read until its snapshot arrives, then hang up. */
async function openUntilSnapshot(
	app: { request: (p: string, i?: RequestInit, env?: unknown) => Response | Promise<Response> },
	peer = '127.0.0.1'
): Promise<number> {
	const res = await app.request(
		'/',
		{ headers: { 'x-real-ip': peer } },
		{
			incoming: { socket: { remoteAddress: '127.0.0.1' } }
		}
	);
	if (res.status !== 200 || res.body === null) return res.status;
	const reader = res.body.getReader();
	let text = '';
	while (!text.includes('event: snapshot')) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	await reader.cancel();
	return 200;
}

describe('SSE streams (E3, E4)', () => {
	beforeEach(() => {
		queries = 0;
		_resetStreamCapsForTest();
	});
	afterEach(() => _resetStreamCapsForTest());

	it('E3: disconnecting from the orderbook stream leaves no listener behind', async () => {
		const before = orderbookEventBus.provisionalSubscriberCount;
		const app = orderbookStreamRoute(db as never, poller as never, 'morphit');
		for (let i = 0; i < 25; i++)
			expect(await openUntilSnapshot(app, `203.0.113.${i + 1}`)).toBe(200);
		// cancel() runs as the reader is cancelled; give it a turn of the loop.
		await Promise.resolve();
		expect(
			orderbookEventBus.provisionalSubscriberCount - before,
			'provisional listeners leaked by disconnected clients'
		).toBe(0);
		expect(orderbookEventBus.subscriberCount).toBe(0);
	});

	it('E4: open directory streams share ONE poll — the query load does not grow with the audience', async () => {
		vi.useFakeTimers();
		try {
			const app = instancesStreamRoute(db as never);
			const res: Response[] = [];
			for (let i = 0; i < 10; i++) {
				const r = await app.request(
					'/',
					{ headers: { 'x-real-ip': `198.51.100.${40 + i}` } },
					{
						incoming: { socket: { remoteAddress: '127.0.0.1' } }
					}
				);
				res.push(r);
				// Drain the preamble + snapshot so the stream is set up.
				const reader = r.body!.getReader();
				let text = '';
				while (!text.includes('event: snapshot')) {
					const { value } = await reader.read();
					text += new TextDecoder().decode(value);
				}
				reader.releaseLock();
			}
			const before = queries;
			await vi.advanceTimersByTimeAsync(5_000 * 3 + 100);
			const perTick = (queries - before) / 3;
			expect(perTick, 'each open stream ran its own directory query').toBeLessThanOrEqual(1);
			for (const r of res) await r.body?.cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	it('E4: one client cannot hold more than its share of open streams (503 past it)', async () => {
		_setStreamCapsForTest({ perClient: 3, global: 100 });
		const app = instancesStreamRoute(db as never);
		const open: Response[] = [];
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await app.request(
				'/',
				{ headers: { 'x-real-ip': '198.51.100.1' } },
				{
					incoming: { socket: { remoteAddress: '127.0.0.1' } }
				}
			);
			statuses.push(res.status);
			open.push(res);
		}
		expect(statuses, 'a sixth-plus stream from one client was accepted').toEqual([
			200, 200, 200, 503, 503
		]);
		// A different client is not affected.
		const other = await app.request(
			'/',
			{ headers: { 'x-real-ip': '198.51.100.2' } },
			{
				incoming: { socket: { remoteAddress: '127.0.0.1' } }
			}
		);
		expect(other.status).toBe(200);
		for (const r of [...open, other]) await r.body?.cancel();
	});

	it('E4: the instance-wide cap holds however many clients there are', async () => {
		_setStreamCapsForTest({ perClient: 100, global: 4 });
		const app = instancesStreamRoute(db as never);
		const res: Response[] = [];
		for (let i = 0; i < 6; i++) {
			res.push(
				await app.request(
					'/',
					{ headers: { 'x-real-ip': `198.51.100.${10 + i}` } },
					{
						incoming: { socket: { remoteAddress: '127.0.0.1' } }
					}
				)
			);
		}
		expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 503, 503]);
		for (const r of res) await r.body?.cancel();
		// Slots come back when clients leave.
		await Promise.resolve();
		const again = await app.request(
			'/',
			{},
			{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
		);
		expect(again.status).toBe(200);
		await again.body?.cancel();
	});
});
