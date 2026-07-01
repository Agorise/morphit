/**
 * Chat-stream pure helpers — tsx smoke runner.
 *
 * Covers:
 *   - parseFilter (input validation + canonicalization)
 *   - eventMatchesFilter (subscriber filter check)
 *   - rowToWire (DB row → wire shape)
 *   - sseEvent (frame formatter)
 *
 * Usage (from apps/indexer):
 *   tsx scripts/chat-stream-smoke.ts
 */

import {
	eventMatchesFilter,
	parseFilter,
	rowToWire,
	sseEvent,
	type ChatStreamRow
} from '../src/api/chatStreamHelpers.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertTrue(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

// ─── parseFilter ─────────────────────────────────────────────────

scenario('parseFilter: valid inputs canonicalize lo<hi', () => {
	const r = parseFilter('alice', 'bob');
	if ('error' in r) throw new Error('expected ok');
	assertEqual(r.lo, 'alice', 'lo');
	assertEqual(r.hi, 'bob', 'hi');
});

scenario('parseFilter: reverses to canonicalize', () => {
	const r = parseFilter('zelda', 'alice');
	if ('error' in r) throw new Error('expected ok');
	assertEqual(r.lo, 'alice', 'lo');
	assertEqual(r.hi, 'zelda', 'hi');
});

scenario('parseFilter: rejects self-chat', () => {
	const r = parseFilter('alice', 'alice');
	assertTrue('error' in r, 'should error');
});

scenario('parseFilter: accepts dotted account names (C-19 regression)', () => {
	// Blurt account names CAN contain dots (multi-segment, e.g.
	// `alice.brave`).  Pre-C-19 fix the chat regex rejected dots,
	// breaking chat for every dotted-name user.  Canonical regex
	// now allows dots.  This test pins that.
	const r = parseFilter('alice.brave', 'bob');
	if ('error' in r) throw new Error('expected ok for dotted name');
	assertEqual(r.lo, 'alice.brave', 'lo');
	assertEqual(r.hi, 'bob', 'hi');
});

scenario('parseFilter: dotted names sort correctly', () => {
	// Dot's ASCII code (46) is BETWEEN '-' (45) and '0' (48), so
	// canonicalization comparing `alice.brave` vs `alice-brave`
	// must order them by char codepoint — verify the behavior is
	// consistent rather than relying on locale.
	const r = parseFilter('alice.brave', 'alice-cool');
	if ('error' in r) throw new Error('expected ok');
	// '-' < '.' so 'alice-cool' < 'alice.brave'
	assertEqual(r.lo, 'alice-cool', 'lo');
	assertEqual(r.hi, 'alice.brave', 'hi');
});

scenario('parseFilter: rejects bad account name (uppercase)', () => {
	const r = parseFilter('Alice', 'bob');
	assertTrue('error' in r, 'should error on uppercase');
});

scenario('parseFilter: rejects bad account name (too short)', () => {
	const r = parseFilter('a', 'bob');
	assertTrue('error' in r, 'should error on 1-char name');
});

scenario('parseFilter: rejects bad account name (empty)', () => {
	const r = parseFilter('', 'bob');
	assertTrue('error' in r, 'should error on empty');
});

// ─── eventMatchesFilter ──────────────────────────────────────────

scenario('eventMatchesFilter: matching pair', () => {
	const f = { lo: 'alice', hi: 'bob' };
	const ev = { lo: 'alice', hi: 'bob' };
	assertTrue(eventMatchesFilter(ev, f), 'should match');
});

scenario('eventMatchesFilter: different pair', () => {
	const f = { lo: 'alice', hi: 'bob' };
	const ev = { lo: 'alice', hi: 'carol' };
	assertTrue(!eventMatchesFilter(ev, f), 'should not match');
});

scenario('eventMatchesFilter: same accounts swapped (canonical handles)', () => {
	// Both filter and event should be canonicalized at construction
	// time; the matcher is a pure equality check.  This test
	// verifies the precondition: pre-canonicalized inputs match.
	const f = parseFilter('alice', 'bob');
	if ('error' in f) throw new Error('expected ok filter');
	const ev = { lo: 'alice', hi: 'bob' };
	assertTrue(eventMatchesFilter(ev, f), 'should match canonicalized');
});

// ─── rowToWire ───────────────────────────────────────────────────

function makeRow(overrides: Partial<ChatStreamRow> = {}): ChatStreamRow {
	return {
		id: 42,
		sender: 'alice',
		recipient: 'bob',
		ciphertext: 'opaque-base64-blob',
		header: { client_tag: 'abc123', ephemeral_pub: 'xyz', nonce: '789' },
		created_at: new Date('2026-04-27T12:00:00Z'),
		...overrides
	};
}

scenario('rowToWire: created_at becomes ISO string', () => {
	const w = rowToWire(makeRow());
	assertEqual(w.created_at, '2026-04-27T12:00:00.000Z', 'iso');
});

scenario('rowToWire: header passes through unchanged', () => {
	const header = { client_tag: 'tag', ephemeral_pub: 'pub', nonce: 'n' };
	const w = rowToWire(makeRow({ header }));
	assertEqual(w.header, header, 'header preserved');
});

scenario('rowToWire: id passes through as number', () => {
	const w = rowToWire(makeRow({ id: 12345 }));
	assertEqual(w.id, 12345, 'id');
});

scenario('rowToWire: ciphertext untouched', () => {
	const w = rowToWire(makeRow({ ciphertext: 'X==Y==' }));
	assertEqual(w.ciphertext, 'X==Y==', 'ciphertext');
});

scenario('rowToWire: sender + recipient untouched', () => {
	const w = rowToWire(makeRow({ sender: 'carol', recipient: 'dave' }));
	assertEqual(w.sender, 'carol', 'sender');
	assertEqual(w.recipient, 'dave', 'recipient');
});

// ─── sseEvent ────────────────────────────────────────────────────

scenario('sseEvent: produces correct frame format', () => {
	const frame = sseEvent('snapshot', { items: [] });
	assertEqual(frame, 'event: snapshot\ndata: {"items":[]}\n\n', 'frame');
});

scenario('sseEvent: handles complex data', () => {
	const data = { id: 42, sender: 'alice', nested: { a: 1 } };
	const frame = sseEvent('message_appended', data);
	const expected = `event: message_appended\ndata: ${JSON.stringify(data)}\n\n`;
	assertEqual(frame, expected, 'complex frame');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
