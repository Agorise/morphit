/**
 * Chat handler — tsx smoke runner.
 *
 * Exercises the Finding H layer-1 block-list gate and layer-3
 * rate-limit gate without vitest. Same style as
 * block-handler-smoke.ts — sanity check at runtime that the
 * gate logic actually behaves as designed.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/chat-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/chat.ts';
import { makeCtx } from '../test/testutils/context.ts';
import { makeMockClient } from '../test/testutils/mockClient.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function goodPayload() {
	return {
		recipient: 'bob',
		ciphertext: 'aGVsbG8=', // valid base64 "hello"
		header: { n: 1, dh: 'a'.repeat(43) }
	};
}

console.log('\n── Chat handler (Finding H gates) ────────────────────');

await scenario('block gate: rejects when block row exists', async () => {
	const mock = makeMockClient([{ match: 'FROM blocks', rows: [{ exists: true }] }]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'recipient_blocked_sender' }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error(`expected 1 query (block check only), got ${mock.queries.length}`);
	}
});

await scenario('block gate: passes when no block row exists', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages' },
		// Part 122 cp13 — successful chat insert is followed by a
		// push_pending enqueue.  cp14 inserts a locale lookup
		// before the enqueue so the indexer can localize.
		{ match: 'SELECT locale FROM push_subscriptions', rows: [{ locale: 'en' }] },
		{ match: 'INSERT INTO push_pending' }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 6) {
		throw new Error(`expected 6 queries (4 chat + locale + push enqueue), got ${mock.queries.length}`);
	}
});

await scenario('admission gate: rejects stranger_fee_required', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		// Admission returns false — no prior exchange, no paid fee.
		{ match: 'admitted', rows: [{ admitted: false }] }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'stranger_fee_required' }, 'result');
	if (mock.queries.length !== 2) {
		throw new Error(`expected 2 queries (block + admission), got ${mock.queries.length}`);
	}
});

await scenario('fan-in: rejects at 21 unique senders', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '21', per_pair_count: '0' }]
		}
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'recipient_fan_in_exceeded' }, 'result');
	if (mock.queries.length !== 3) {
		throw new Error(`expected 3 queries (no INSERT), got ${mock.queries.length}`);
	}
});

await scenario('fan-in: accepts at exactly 20 (at cap)', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '20', per_pair_count: '0' }]
		},
		{ match: 'INSERT INTO chat_messages' }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('per-pair cap: rejects at 50 prior messages', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: '50' }]
		}
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'sender_no_reply_cap_exceeded' }, 'result');
});

await scenario('per-pair cap: accepts 50th message (count=49 before)', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: '49' }]
		},
		{ match: 'INSERT INTO chat_messages' }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('per-pair cap: lifted when recipient has replied (null)', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages' }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('fan-in SQL excludes blocked senders (security S5 regression guard)', async () => {
	// Security audit S5: a blocked sender's prior message used to
	// count toward the recipient's fan-in budget for 24h, letting
	// a Sybil burst lock out new legitimate senders. Mitigation:
	// the fan-in subquery now anti-joins against `blocks` so
	// blocked-sender slots are excluded. This test asserts the
	// SQL has not regressed away from that guarantee.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: '0' }]
		},
		{ match: 'INSERT INTO chat_messages' }
	]);
	await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	// Find the fan-in query in the recorded list and verify the
	// blocked-exclusion is present.
	const fanInQuery = mock.queries.find((q) => q.text.includes('unique_fan_in'));
	if (!fanInQuery) {
		throw new Error('expected a unique_fan_in query, found none');
	}
	// Two anti-joins are expected: the existing reply anti-join
	// (`FROM chat_messages r`) and the new block anti-join
	// (`FROM blocks b`). Check for the blocks one specifically.
	if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM blocks b/i.test(fanInQuery.text)) {
		throw new Error(`fan-in SQL missing block anti-join. Got:\n${fanInQuery.text}`);
	}
	if (!/state\s*=\s*'blocked'/i.test(fanInQuery.text)) {
		throw new Error('fan-in SQL block anti-join must filter on state=blocked');
	}
});

await scenario('validation: rejects non-object payload before any queries', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ signer: 'alice', payload: 'nope' as unknown }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
	if (mock.queries.length !== 0) {
		throw new Error(`validation failures should not hit the DB, got ${mock.queries.length}`);
	}
});

await scenario('validation: rejects self-chat', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), recipient: 'alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'self_chat' }, 'result');
});

await scenario('duplicate: 23505 maps to duplicate_message', async () => {
	const pgErr = Object.assign(new Error('dup'), { code: '23505' });
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages', throwError: pgErr }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'duplicate_message' }, 'result');
});

// ─── Ciphertext size bound (regression guard for cap mismatch
// found in the chat audit: previous 1024-char cap rejected
// 256-codepoint emoji-heavy messages whose ciphertext is ≈1388
// base64 chars). ───
await scenario('ciphertext at cap (1536 chars) is accepted', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages', rows: [] }
	]);
	const ct = 'a'.repeat(1536);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { recipient: 'bob', ciphertext: ct, header: { n: 1 } }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('ciphertext one over cap (1537 chars) is rejected', async () => {
	const mock = makeMockClient([]);
	const ct = 'a'.repeat(1537);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { recipient: 'bob', ciphertext: ct, header: { n: 1 } }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'ciphertext_too_long' }, 'result');
});

await scenario('256-codepoint emoji worst-case (1388 chars) is accepted', async () => {
	// Regression guard: this was the bug. A 256-codepoint
	// all-4-byte-emoji plaintext encrypts to 1040 ciphertext
	// bytes (1024 plaintext + 16 ChaCha20-Poly1305 tag) which
	// base64-encodes to 1388 chars — over the previous 1024
	// cap. With the new 1536 cap, this passes.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages', rows: [] }
	]);
	const ct = 'a'.repeat(1388);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { recipient: 'bob', ciphertext: ct, header: { n: 1 } }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

console.log(`\n${'─'.repeat(54)}`);

// ─── Q11 — order_permlink bypass scenarios ──────────────────────
//
// The chat handler accepts an optional `order_permlink` field.
// When present and naming a real order owned by the recipient,
// the stranger-fee gate (layer 2) is bypassed.  The block list
// (layer 1) and rate limits (layer 3) are NOT bypassed.

console.log('── Q11: order_permlink bypass ─────────────────────────');

await scenario('Q11: bypass works for valid recipient-owned order', async () => {
	// Block: not blocked.
	// orders: row exists.
	// Stranger-fee gate is SKIPPED (no admitted query).
	// Layer 3: ok.
	// Insert.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		// cp446 — the orders lookup now returns WHO owns it and WHETHER it is live,
		// so the handler can grant the thread tag and the fee bypass separately.
		{ match: 'FROM orders', rows: [{ account: 'bob', live: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages' },
		// Part 122 cp14 — locale lookup before push enqueue so the
		// indexer can localize.  Order-permlink messages route
		// under category='order' for fan-in to the right notify
		// channel.
		{ match: 'SELECT locale FROM push_subscriptions', rows: [{ locale: 'en' }] },
		{ match: 'INSERT INTO push_pending' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'morphit-2026-05-01-abc' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 6) {
		throw new Error(
			`expected 6 queries (block + orders + fan-in + chat insert + locale + push enqueue), got ${mock.queries.length}`
		);
	}
	// cp446 — the orders query binds (permlink, recipient, blockTime, signer): it
	// looks the order up among BOTH parties so the owner can tag their own thread,
	// and it needs blockTime to decide liveness for the bypass.
	const ordersQuery = mock.queries[1];
	if (
		ordersQuery.params[0] !== 'morphit-2026-05-01-abc' ||
		ordersQuery.params[1] !== 'bob' ||
		ordersQuery.params[3] !== 'alice'
	) {
		throw new Error(
			`orders query should be parameterized on (permlink, recipient, blockTime, signer); got ${JSON.stringify(ordersQuery.params)}`
		);
	}
	// BATCH19A-chat-1 regression: the orders query must filter
	// by status='live' so cancelled/expired permlinks can't be
	// replayed indefinitely to bypass the stranger-fee gate.
	if (!/status\s*=\s*'live'/.test(ordersQuery.text)) {
		throw new Error(
			`orders query must filter by status='live' to defeat ` +
				`the cancelled-order replay (BATCH19A-chat-1); got: ${ordersQuery.text}`
		);
	}
});

await scenario('BATCH19A-chat-1: cancelled-order permlink does NOT bypass gate', async () => {
	// The bypass attack: eve cites a REAL order of bob's that has since been
	// cancelled, hoping "a posted order is consent to be contacted" still applies.
	//
	// cp446 changed the SHAPE of this defence, not its strength. The permlink is
	// now also a thread tag, so a cancelled order no longer rejects the message
	// outright — it simply grants NO BYPASS. Eve therefore falls through to the
	// stranger-fee gate she was always supposed to hit, and is stopped there.
	//
	// The assertion is the SECURITY PROPERTY (eve does not get in), plus the
	// mechanism (the gate actually ran). Asserting the old `order_permlink_not_found`
	// reason string would have been asserting an implementation detail.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		// bob's order exists, but it is not live.
		{ match: 'FROM orders', rows: [{ account: 'bob', live: false }] },
		// …so the stranger-fee gate RUNS: eve was never admitted and never paid.
		{ match: 'FROM chat_messages', rows: [{ admitted: false }] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'eve',
			payload: { ...goodPayload(), order_permlink: 'cancelled-order-xyz' }
		}),
		mock.client
	);
	assertEqual(
		r,
		{ ok: false, reason: 'stranger_fee_required' },
		'a cancelled order must not admit a stranger'
	);
	if (!mock.queries.some((q) => /FROM chat_messages/.test(q.text))) {
		throw new Error(
			'the stranger-fee gate did not run — a cancelled order silently bypassed it'
		);
	}
});

await scenario('cp446: the ORDER OWNER may reply in their own thread', async () => {
	// bob owns the order. He is not the recipient of his own listing, so the old
	// handler rejected his reply with `order_permlink_not_found` — the order owner
	// could not answer in the very thread his order created.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'FROM orders', rows: [{ account: 'bob', live: true }] },
		// No bypass (bob does not own the RECIPIENT relationship), so the gate runs
		// and passes: alice has messaged bob before, so bob is admitted.
		{ match: 'FROM chat_messages', rows: [{ admitted: true }] },
		{ match: 'unique_fan_in', rows: [{ unique_fan_in: '1', per_pair_count: null }] },
		{ match: 'INSERT INTO chat_messages' },
		{ match: 'SELECT locale FROM push_subscriptions', rows: [{ locale: 'en' }] },
		{ match: 'INSERT INTO push_pending' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'bob',
			payload: {
				...goodPayload(),
				recipient: 'alice',
				order_permlink: 'morphit-2026-05-01-abc'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'the order owner must be able to reply');
});

await scenario('cp446: an ADMITTED pair may keep talking after the order is cancelled', async () => {
	// The inbox shows "(Cancelled)" threads. They must not be write-only graves.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'FROM orders', rows: [{ account: 'bob', live: false }] },
		{ match: 'FROM chat_messages', rows: [{ admitted: true }] },
		{ match: 'unique_fan_in', rows: [{ unique_fan_in: '1', per_pair_count: null }] },
		{ match: 'INSERT INTO chat_messages' },
		{ match: 'SELECT locale FROM push_subscriptions', rows: [{ locale: 'en' }] },
		{ match: 'INSERT INTO push_pending' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'cancelled-order-xyz' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'a cancelled order must not silence an admitted pair');
});

await scenario('cp446: a permlink owned by NEITHER party is still rejected', async () => {
	// A tag must never be a free-text field on chain.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'FROM orders', rows: [] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'eve',
			payload: { ...goodPayload(), order_permlink: 'carols-order-999' }
		}),
		mock.client
	);
	assertEqual(
		r,
		{ ok: false, reason: 'order_permlink_not_found' },
		'a third party\u2019s order may not be used as a tag'
	);
});

await scenario('Q11: order_permlink not found rejects the message', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		// cp446 — "not found" is now an EMPTY result set, not a row saying so.
		{ match: 'FROM orders', rows: [] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'fake-permlink-001' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'order_permlink_not_found' }, 'result');
});

await scenario('Q11: order_permlink with bad chars rejects', async () => {
	// Block check still runs first; then the field validator
	// fails before any DB lookup of orders.
	const mock = makeMockClient([{ match: 'FROM blocks', rows: [{ exists: false }] }]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'BAD CAPS!!!' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'order_permlink_bad_chars' }, 'result');
});

await scenario('Q11: order_permlink not a string rejects', async () => {
	const mock = makeMockClient([{ match: 'FROM blocks', rows: [{ exists: false }] }]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 12345 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'order_permlink_not_string' }, 'result');
});

await scenario('Q11: bypass does NOT override block list', async () => {
	// Block check fires FIRST and rejects regardless of any
	// order_permlink claim.  This is the security boundary —
	// a blocked sender cannot use an old order to push through.
	const mock = makeMockClient([{ match: 'FROM blocks', rows: [{ exists: true }] }]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'real-permlink-001' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'recipient_blocked_sender' }, 'result');
	// Only the block check ran; orders lookup never happened.
	if (mock.queries.length !== 1) {
		throw new Error(
			`block must short-circuit BEFORE orders lookup; got ${mock.queries.length} queries`
		);
	}
});

await scenario('Q11: bypass does NOT override fan-in rate limit', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'FROM orders', rows: [{ account: 'bob', live: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '21', per_pair_count: null }]
		}
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'real-permlink-002' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'recipient_fan_in_exceeded' }, 'result');
});

await scenario('Q11: omitting order_permlink keeps gate behavior unchanged', async () => {
	// No order_permlink in payload → no orders lookup, gate runs.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: false }] }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: false, reason: 'stranger_fee_required' }, 'result');
});

await scenario('Q11: null order_permlink treated as omitted', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: false }] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: null }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'stranger_fee_required' }, 'result');
});

// ─── Engagement counter persistence (#5 / schema-v25) ───────────
//
// The orderbook's `engagement_24h` chip is computed from
// chat_messages.order_permlink.  These scenarios pin the
// handler's INSERT behavior so the counter aggregate stays
// honest across refactors.

console.log('── #5: order_permlink persistence ──────────────────────');

await scenario('#5: bypass-success persists order_permlink on insert', async () => {
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'FROM orders', rows: [{ account: 'bob', live: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages', rows: [{ id: '42' }] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { ...goodPayload(), order_permlink: 'morphit-2026-05-01-xyz' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const insertQ = mock.queries[3];
	// Per the v25 column order: sender, recipient, ciphertext,
	// header, created_at, source_trx_id, order_permlink.
	const lastParam = insertQ.params[insertQ.params.length - 1];
	if (lastParam !== 'morphit-2026-05-01-xyz') {
		throw new Error(
			`expected order_permlink to be persisted as last param; got ${JSON.stringify(lastParam)}`
		);
	}
});

await scenario('#5: no order_permlink path persists NULL', async () => {
	// Standard admission via prior exchange — gate runs, no
	// order_permlink in payload, INSERT must store NULL.
	const mock = makeMockClient([
		{ match: 'FROM blocks', rows: [{ exists: false }] },
		{ match: 'admitted', rows: [{ admitted: true }] },
		{
			match: 'unique_fan_in',
			rows: [{ unique_fan_in: '1', per_pair_count: null }]
		},
		{ match: 'INSERT INTO chat_messages', rows: [{ id: '43' }] }
	]);
	const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	const insertQ = mock.queries[3];
	const lastParam = insertQ.params[insertQ.params.length - 1];
	if (lastParam !== null) {
		throw new Error(
			`expected order_permlink NULL on no-bypass path; got ${JSON.stringify(lastParam)}`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
