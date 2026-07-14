/**
 * chat-sse-order-permlink-smoke — the chat SSE wire serializer (`rowToWire`)
 * MUST carry `order_permlink`.
 *
 * cp470 — the client threads chat by (peer, order) and drops any live message
 * whose `order_permlink` doesn't match the open thread (cp446 filter). When
 * `rowToWire` omitted the field, every SSE event (snapshot, fast-path
 * provisional, durable bus push) shipped an implicit null tag, so live
 * messages in an ORDER thread were filtered out and only surfaced ~one
 * main-indexer lag later via the REST poll — the ~60s "fast chat broken"
 * bug. General (order-less) threads were unaffected (their tag is truly null),
 * which is exactly why it hid for a release.
 *
 * This is a FUNCTIONAL guard: it calls the real serializer and fails if the
 * tag is dropped — for a real permlink AND for the null order-less case.
 */
import { rowToWire } from '../src/api/chatStreamHelpers';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

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
		console.log(`      ${String((err as Error)?.message ?? err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const base = {
	id: 42,
	sender: 'alice',
	recipient: 'bob',
	ciphertext: 'Y2lwaGVy',
	header: { client_tag: 'deadbeefdeadbeefdeadbeefdeadbeef' },
	created_at: new Date('2026-07-13T00:00:00.000Z'),
	source_trx_id: 'trx-abc'
};

scenario('rowToWire preserves a real order_permlink (order thread)', () => {
	const wire = rowToWire({ ...base, order_permlink: 'order-rvgezakynm8d' });
	assert('order_permlink' in wire, 'wire is missing the order_permlink key entirely');
	assert(
		wire.order_permlink === 'order-rvgezakynm8d',
		`order_permlink not carried through: got ${JSON.stringify(wire.order_permlink)}`
	);
});

scenario('rowToWire preserves a null order_permlink (order-less thread)', () => {
	const wire = rowToWire({ ...base, order_permlink: null });
	assert('order_permlink' in wire, 'wire is missing the order_permlink key entirely');
	assert(wire.order_permlink === null, `null order_permlink not preserved: got ${JSON.stringify(wire.order_permlink)}`);
});

scenario('rowToWire still carries the other core fields', () => {
	const wire = rowToWire({ ...base, order_permlink: null });
	assert(wire.id === 42, 'id lost');
	assert(wire.sender === 'alice' && wire.recipient === 'bob', 'sender/recipient lost');
	assert(wire.ciphertext === 'Y2lwaGVy', 'ciphertext lost');
	assert(wire.source_trx_id === 'trx-abc', 'source_trx_id lost');
	assert(wire.created_at === '2026-07-13T00:00:00.000Z', 'created_at not ISO-serialized');
});

// ─── Supply-chain guards (cp470) ─────────────────────────────────────────────
// rowToWire is only the last hop. The ~5s order-thread render also depends on
// (a) the SSE queries fetching the column, (b) the fast-path provisional wiring
// ev.orderPermlink into rowToWire, and (c) the head tailer extracting the tag
// off-chain. If ANY of these regress, order-thread live chat silently falls
// back to the ~60s durable/poll path. Guard the whole chain, not just the tail.

scenario('chatStream SSE queries fetch order_permlink (supply the row)', () => {
	const cs = readFileSync(join(SRC, 'api/chatStream.ts'), 'utf8');
	assert(/SELECT[\s\S]*?order_permlink/.test(cs), 'no SELECT in chatStream.ts fetches order_permlink — rowToWire would receive undefined and ship a null tag');
	const occ = (cs.match(/order_permlink/g) ?? []).length;
	assert(occ >= 5, `order_permlink occurrences in chatStream.ts dropped to ${occ} (<5) — a query or row-type likely lost it`);
});

scenario('fast-path provisional carries ev.orderPermlink into the wire', () => {
	const cs = readFileSync(join(SRC, 'api/chatStream.ts'), 'utf8');
	assert(
		/order_permlink:\s*ev\.orderPermlink/.test(cs),
		'pushFast no longer wires `order_permlink: ev.orderPermlink` — the provisional would ship a null tag and the ~5s order-thread render regresses to the ~60s durable/poll path'
	);
});

scenario('chatHeadTailer extracts + forwards the on-chain order_permlink', () => {
	const ht = readFileSync(join(SRC, 'indexer/chatHeadTailer.ts'), 'utf8');
	assert(/\.order_permlink/.test(ht), 'chatHeadTailer no longer reads payload.order_permlink off the on-chain op');
	assert(/orderPermlink/.test(ht), 'chatHeadTailer no longer forwards orderPermlink in the fast event');
});

if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} of ${scenarios} chat-sse-order-permlink checks FAILED`);
	process.exit(1);
}
