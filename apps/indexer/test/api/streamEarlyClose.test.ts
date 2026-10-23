/**
 * A chat stream whose client leaves while its ticket is still being checked
 * must not keep a slot (v1.21.14 review B, F1).
 *
 * The two chat streams check a ticket BEFORE they take a slot, and that check
 * waits on a key read (a database read, a signature recovery, for some
 * accounts a chain read). @hono/node-server registers its "client gone"
 * listener only once the response is being written, and writes nothing to a
 * socket that is already closed — so a client that left during the check
 * never cancelled its stream: the slot, the bus listeners and the keepalive
 * timer stayed until the indexer restarted. Twelve page reloads over Tor (one
 * new ticket each) and an account had no live chat left.
 *
 * Real server, real sockets: the client sends its request and closes at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

import { chatActivityStreamRoute } from '$api/chatActivityStream';
import { chatStreamRoute } from '$api/chatStream';
import { openStreamCount, _resetStreamCapsForTest } from '$api/streamCaps';
import { _resetStreamTicketsForTest, type TicketKeyLookup } from '$api/streamTicket';
import { chatEventBus } from '$indexer/chatEventBus';
import { streamTickets, TEST_STREAM_HOST } from '../testutils/streamTickets';

const T = await streamTickets();
/**
 * A key read that waits for the test: it reports that the check has started
 * (the request is in), and answers only once the client has gone — the slow
 * case (a chain read for an account the database lacks), driven by events.
 */
let gate: { arrived: () => void; release: Promise<void>; returned: () => void } | null = null;
let handlerDone: (() => void) | null = null;
const slowLookup: TicketKeyLookup = async (account, ...rest) => {
	const g = gate;
	if (g !== null) {
		g.arrived();
		await g.release;
	}
	try {
		return await T.lookupKey(account, ...rest);
	} finally {
		g?.returned();
	}
};
const db = { query: async () => ({ rows: [], rowCount: 0 }) };
const poller = { getStatus: () => ({ indexedBlock: 1 }) };

let server: ServerType;
let port = 0;

beforeAll(async () => {
	const app = new Hono();
	// Tells the test when a request's handler has returned (its stream, or no
	// stream), so the next request never overlaps it.
	app.use('*', async (_c, next) => {
		try {
			await next();
		} finally {
			handlerDone?.();
		}
	});
	const opts = { lookupKey: slowLookup, instanceHosts: [TEST_STREAM_HOST] };
	app.route('/v1/chat-activity', chatActivityStreamRoute(opts));
	app.route('/v1/chat', chatStreamRoute(db as never, poller as never, opts));
	await new Promise<void>((resolve) => {
		server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
	});
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
	_resetStreamTicketsForTest();
	_resetStreamCapsForTest();
});
afterEach(() => _resetStreamCapsForTest());

/** A few turns of the event loop (no clock involved). */
async function turns(n = 20): Promise<void> {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Send the request; once its ticket check has started, hang up; then let the
 *  check finish. Resolves when the handler has had every chance to take a slot. */
async function requestAndLeave(path: string): Promise<void> {
	let arrived!: () => void;
	let release!: () => void;
	let returned!: () => void;
	const arrivedP = new Promise<void>((r) => (arrived = r));
	const returnedP = new Promise<void>((r) => (returned = r));
	const doneP = new Promise<void>((r) => (handlerDone = r));
	gate = { arrived, release: new Promise<void>((r) => (release = r)), returned };
	const closed = new Promise<void>((resolve) => {
		const s = connect(port, '127.0.0.1', () => {
			s.write(
				`GET ${path} HTTP/1.1\r\nHost: ${TEST_STREAM_HOST}\r\nAccept: text/event-stream\r\n\r\n`
			);
			void arrivedP.then(() => s.destroy());
		});
		s.on('close', () => resolve());
		s.on('error', () => resolve());
	});
	await closed;
	// The server notices the closed socket on its own turn of the loop.
	await turns();
	release();
	await returnedP;
	await doneP;
	gate = null;
	handlerDone = null;
	await turns();
}

describe('a client that leaves during the ticket check (review B, F1)', () => {
	it('activity stream: no slot and no bus listener is left behind', async () => {
		const durableBefore = chatEventBus.subscriberCount;
		const fastBefore = chatEventBus.fastSubscriberCount;
		for (let i = 0; i < 6; i++)
			await requestAndLeave(
				`/v1/chat-activity/alice/stream?ticket=${encodeURIComponent(T.ticketFor('alice', { ttlS: 3600 + i }))}`
			);
		await vi.waitFor(
			() => {
				expect(openStreamCount(), 'open stream slots after every client left').toBe(0);
				expect(chatEventBus.subscriberCount - durableBefore).toBe(0);
				expect(chatEventBus.fastSubscriberCount - fastBefore).toBe(0);
			},
			{ timeout: 2000 }
		);
	});

	it('conversation stream: no slot and no bus listener is left behind', async () => {
		const durableBefore = chatEventBus.subscriberCount;
		const fastBefore = chatEventBus.fastSubscriberCount;
		for (let i = 0; i < 6; i++)
			await requestAndLeave(
				`/v1/chat/alice/bob/stream?ticket=${encodeURIComponent(T.ticketFor('alice', { ttlS: 3600 + i }))}`
			);
		await vi.waitFor(
			() => {
				expect(openStreamCount(), 'open stream slots after every client left').toBe(0);
				expect(chatEventBus.subscriberCount - durableBefore).toBe(0);
				expect(chatEventBus.fastSubscriberCount - fastBefore).toBe(0);
			},
			{ timeout: 2000 }
		);
	});

	it('control: a client that stays gets its stream, and leaving later frees the slot', async () => {
		await new Promise<void>((resolve, reject) => {
			const s = connect(port, '127.0.0.1', () => {
				s.write(
					`GET /v1/chat-activity/alice/stream?ticket=${encodeURIComponent(T.ticketFor('alice'))} HTTP/1.1\r\nHost: ${TEST_STREAM_HOST}\r\n\r\n`
				);
			});
			let got = '';
			s.on('data', (d) => {
				got += d.toString();
				if (got.includes('event: ready')) {
					expect(openStreamCount()).toBe(1);
					s.destroy();
					resolve();
				}
			});
			s.on('error', reject);
		});
		await vi.waitFor(() => expect(openStreamCount()).toBe(0));
	});
});
