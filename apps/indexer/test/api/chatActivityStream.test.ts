/**
 * Tests for the global chat-activity SSE (/v1/chat-activity/:account/stream).
 *
 * Verifies: it validates the account; it pushes a `chat_activity` ping ONLY
 * when the account is a participant (filtering out unrelated conversations);
 * the ping carries the correct peer; and — the privacy invariant — it NEVER
 * emits ciphertext/content, only the peer account name.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { chatActivityStreamRoute } from '$api/chatActivityStream';
import { chatEventBus } from '$indexer/chatEventBus';

/** Read decoded chunks from an SSE body until `substr` appears (or time out). */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	substr: string,
	ms = 3000
): Promise<string> {
	const dec = new TextDecoder();
	let acc = '';
	const deadline = Date.now() + ms;
	while (!acc.includes(substr)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`timeout waiting for "${substr}"; got: ${JSON.stringify(acc)}`);
		const step = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: true }>((resolve) =>
				setTimeout(() => resolve({ value: undefined, done: true }), remaining)
			)
		]);
		if (step.done) {
			if (!acc.includes(substr)) throw new Error(`stream ended before "${substr}"; got: ${JSON.stringify(acc)}`);
			break;
		}
		acc += dec.decode(step.value);
	}
	return acc;
}

let openReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
afterEach(() => {
	if (openReader !== null) {
		void openReader.cancel().catch(() => {});
		openReader = null;
	}
});

describe('chatActivityStreamRoute', () => {
	it('rejects an invalid account name with 400', async () => {
		const app = chatActivityStreamRoute();
		const res = await app.request('/Invalid_Name/stream');
		expect(res.status).toBe(400);
	});

	it('opens an event-stream and sends a ready event', async () => {
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		expect(res.headers.get('cache-control')).toContain('no-store');
		const reader = res.body!.getReader();
		openReader = reader;
		const acc = await readUntil(reader, 'event: ready');
		expect(acc).toContain('event: ready');
	});

	it('pings ONLY for conversations the account is in, carries the peer, and leaks no content', async () => {
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;
		// Subscriptions are active once `ready` has been pushed.
		await readUntil(reader, 'event: ready');

		// A conversation alice is NOT part of — must be filtered out (no frame).
		chatEventBus.emit({ lo: 'bob', hi: 'carol', messageId: 99 });
		// A durable event alice IS part of — peer is the other participant.
		chatEventBus.emit({ lo: 'alice', hi: 'dave', messageId: 1 });

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('event: chat_activity');
		expect(frame).toContain('"peer":"dave"');
		// The unrelated (bob,carol) conversation never produced a frame.
		expect(frame).not.toContain('carol');
		expect(frame).not.toContain('bob');
		// PRIVACY: the ping is metadata-only — no ciphertext/content/header/id.
		expect(frame).not.toMatch(/ciphertext|header|messageId|"id"/);
	});

	it('handles the head-block fast path too (sub-second, pre-DB) with peer + no content', async () => {
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;
		await readUntil(reader, 'event: ready');

		// Fast event where alice is the recipient → peer is the sender.
		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'erin',
			sender: 'erin',
			recipient: 'alice',
			ciphertext: 'SECRETCIPHERTEXTBLOB==',
			header: { client_tag: 'x' },
			createdAt: new Date(),
			clientTag: 'x'
		});

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"erin"');
		// The ciphertext from the fast event must NOT appear on the wire.
		expect(frame).not.toContain('SECRETCIPHERTEXTBLOB');
		expect(frame).not.toContain('ciphertext');
	});
});
