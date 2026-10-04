/**
 * Tests for the global chat-activity SSE (/v1/chat-activity/:account/stream).
 *
 * Verifies: it validates the account; it pushes a `chat_activity` ping ONLY
 * when the account is a participant (filtering out unrelated conversations);
 * the ping carries the correct peer; and — the privacy invariant — it NEVER
 * emits ciphertext/content, only the peer account name.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

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

// The bus is a process-wide singleton and its replay ring outlives a case, so
// a replayable event emitted by one test is delivered to the next test's stream
// at connect — ahead of anything that test emits itself. Every assertion about
// "the first frame" is otherwise reading the previous case's leftovers.
beforeEach(() => {
	chatEventBus._resetFastRingForTest();
});

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
		// `replayable: true` is the safe-subset gate's answer — "this sender may
		// notify this person" — and an INBOUND ping now requires it, exactly as
		// the web push and the cold-start replay always have. See the case below
		// for what happens without it.
		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'erin',
			sender: 'erin',
			recipient: 'alice',
			ciphertext: 'SECRETCIPHERTEXTBLOB==',
			header: { client_tag: 'x' },
			createdAt: new Date(),
			clientTag: 'x',
			orderPermlink: null,
			replayable: true
		});

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"erin"');
		// The ciphertext from the fast event must NOT appear on the wire.
		expect(frame).not.toContain('SECRETCIPHERTEXTBLOB');
		expect(frame).not.toContain('ciphertext');
	});

	it('does NOT light the inbox for a sender the gate refused', async () => {
		// The counterpart to the case above, and the reason it exists.
		//
		// Every other consumer of a fast event checks `replayable` before acting
		// on it: the web push does, the cold-start replay does. This listener did
		// not, which left the live badge as the one unguarded route into
		// somebody's inbox. That mattered little while every chat message had to
		// come out of a block — it cost resource credits and left a public record
		// — and matters a great deal now that a peer instance can push one
		// straight in: a signed chat op is free to mint offline, so an ungated
		// badge was a free, repeatable, untraceable ping at any account, tagged
		// with any thread the sender chose to name.
		//
		// A refused sender must produce NOTHING here. The message is still
		// delivered into an open chatroom — a conversation you are looking at is
		// not a notification — and the durable path still judges it on its own
		// terms.
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;
		await readUntil(reader, 'event: ready');

		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'mallory',
			sender: 'mallory',
			recipient: 'alice',
			ciphertext: 'SPAM==',
			header: { client_tag: 'spam' },
			createdAt: new Date(),
			clientTag: 'spam',
			orderPermlink: 'some-order-mallory-picked'
			// replayable deliberately absent — the gate said no.
		});
		// And one the gate DID allow, after it, so this is a test of ordering
		// rather than of the stream simply being slow: if the refused ping were
		// still being written, it would arrive first and this assertion would see
		// mallory rather than erin.
		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'erin',
			sender: 'erin',
			recipient: 'alice',
			ciphertext: 'OK==',
			header: { client_tag: 'ok' },
			createdAt: new Date(),
			clientTag: 'ok',
			orderPermlink: null,
			replayable: true
		});

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"erin"');
		expect(frame).not.toContain('mallory');
	});

	it('still tells the SENDER about their own message on another device', async () => {
		// The gate governs who may notify YOU. It has nothing to say about your
		// own outgoing message reaching your other tabs, and gating that would
		// break multi-device echo for every send — including the sends that go
		// out before the recipient has ever replied, which is most first
		// messages. The client ignores anything not marked inbound, so this frame
		// is a reconcile hint rather than a badge.
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;
		await readUntil(reader, 'event: ready');

		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'grace',
			sender: 'alice',
			recipient: 'grace',
			ciphertext: 'MINE==',
			header: { client_tag: 'mine' },
			createdAt: new Date(),
			clientTag: 'mine',
			orderPermlink: null
			// Not replayable — alice has never been replied to by grace. Her own
			// message must still reach her other devices.
		});

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"grace"');
		expect(frame).toContain('"inbound":false');
	});

	// ─── v1.7.5: the COLD START ───────────────────────────
	//
	// Requirement: with the browser fully closed, opening Morphit in a new tab shows the badges
	// within 6 seconds.
	//
	// This is the one case no live stream can serve: the message arrived while no
	// page existed to hear it, and `getConversations` legitimately cannot help
	// because the fast path never writes that table (ADR-0051 invariant #1). The
	// events have to be handed to whoever connects next.

	it('replays what a CLOSED browser missed, so a cold start badges immediately', async () => {
		// Recent on purpose: the ring prunes by BLOCK time against a 5-minute TTL
		// (rightly — past that the indexer has the message anyway), so a fixed
		// past date would be pruned before the connect and prove nothing. 10s ago
		// models the maintainer opening a tab right after the message landed.
		const at = new Date(Date.now() - 10_000);
		// A message lands while nobody is connected — the maintainer's browser is shut.
		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'frank',
			sender: 'frank',
			recipient: 'alice',
			ciphertext: 'COLDSTARTCIPHERTEXT==',
			header: { client_tag: 'c1' },
			createdAt: at,
			clientTag: 'c1',
			orderPermlink: 'order-cold',
			replayable: true
		});

		// NOW he opens a tab and signs in. No live event will ever fire for that
		// message again.
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"frank"');
		expect(frame).toContain('"order":"order-cold"');
		expect(frame).toContain('"inbound":true');
		// The message's REAL time, not now(). Replaying with now() would date an
		// old message to this instant, push it past the read cursor, and light a
		// badge for something already read.
		expect(frame).toContain(`"at":${at.getTime()}`);
		// Still no content, replay or not.
		expect(frame).not.toContain('COLDSTARTCIPHERTEXT');
	});

	it('replays BEFORE ready, so the badge lights then reconciles (never blinks)', async () => {
		chatEventBus.emitFast({
			lo: 'alice',
			hi: 'grace',
			sender: 'grace',
			recipient: 'alice',
			ciphertext: 'X==',
			header: {},
			createdAt: new Date(Date.now() - 10_000),
			clientTag: null,
			orderPermlink: null,
			replayable: true
		});
		const app = chatActivityStreamRoute();
		const res = await app.request('/alice/stream');
		const reader = res.body!.getReader();
		openReader = reader;

		const frame = await readUntil(reader, 'event: ready');
		// Assert PRESENCE first. Without this the ordering check passes vacuously:
		// indexOf returns -1 when absent, and -1 is less than any real index — so a
		// replay that never happened would "prove" correct ordering.
		expect(frame).toContain('"peer":"grace"');
		// `ready` triggers the client's reconciling poll. Replaying after it would
		// paint the badge, poll a table that doesn't have the message, and blink.
		expect(frame.indexOf('chat_activity')).toBeLessThan(frame.indexOf('event: ready'));
	});

	it('never replays a message the account has nothing to do with', async () => {
		// A fresh account: the ring is a module-level singleton, so reusing `alice`
		// here would trip over the other tests' fixtures and prove nothing.
		chatEventBus.emitFast({
			lo: 'bob',
			hi: 'carol',
			sender: 'bob',
			recipient: 'carol',
			ciphertext: 'X==',
			header: {},
			createdAt: new Date(Date.now() - 10_000),
			clientTag: null,
			orderPermlink: null,
			replayable: true
		});
		const app = chatActivityStreamRoute();
		const res = await app.request('/zara/stream');
		const reader = res.body!.getReader();
		openReader = reader;

		const frame = await readUntil(reader, 'event: ready');
		expect(frame).not.toContain('chat_activity');
	});

	it("marks a REPLAYED message the account SENT as not inbound (never badge your own words)", async () => {
		//  #2's bug, at the replay layer: this is a PARTICIPANT stream, so it
		// replays what the maintainer SENT from his PC too. Badging that on his phone is
		// exactly what he reported.
		chatEventBus.emitFast({
			lo: 'heidi',
			hi: 'yuri',
			sender: 'yuri',
			recipient: 'heidi',
			ciphertext: 'X==',
			header: {},
			createdAt: new Date(Date.now() - 10_000),
			clientTag: null,
			orderPermlink: null,
			replayable: true
		});
		const app = chatActivityStreamRoute();
		const res = await app.request('/yuri/stream');
		const reader = res.body!.getReader();
		openReader = reader;

		const frame = await readUntil(reader, 'chat_activity');
		expect(frame).toContain('"peer":"heidi"');
		expect(frame).toContain('"inbound":false');
	});

	it('does NOT replay a first-contact stranger (the durable path may reject it)', async () => {
		// Fresh account for the same singleton-ring reason.
		// `replayable` is the same safe-subset gate that authorises a fast push. A
		// stranger's message still streams LIVE, but replaying it would show a ghost
		// that vanishes on reload if the durable handler rejects it under the
		// stranger-fee / fan-in caps the fast path cannot run.
		chatEventBus.emitFast({
			lo: 'ivan',
			hi: 'wanda',
			sender: 'ivan',
			recipient: 'wanda',
			ciphertext: 'X==',
			header: {},
			createdAt: new Date(Date.now() - 10_000),
			clientTag: null,
			orderPermlink: null,
			replayable: false
		});
		const app = chatActivityStreamRoute();
		const res = await app.request('/wanda/stream');
		const reader = res.body!.getReader();
		openReader = reader;

		const frame = await readUntil(reader, 'event: ready');
		expect(frame).not.toContain('"peer":"ivan"');
	});
});
