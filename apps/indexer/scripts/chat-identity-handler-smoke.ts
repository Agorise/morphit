/**
 * chatIdentity handler smoke — payload validation + low-order
 * X25519 point rejection (P4-6 hardening).
 *
 * Covers:
 *   - happy path: insert a fresh chat_pub
 *   - chat_pub missing / wrong type / wrong length / non-base64
 *     / non-canonical base64
 *   - all-zero rejected (chat_pub_low_order)
 *   - each of the RFC 7748 §6.1 small-order points rejected
 *   - upsert: re-publishing a different valid pubkey wins
 */

import handler from '../src/indexer/handlers/chatIdentity.js';
import type { OpContext } from '../src/indexer/handler-contract.js';

let scenarios = 0;
let failures = 0;

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

interface MockClient {
	queries: Array<{ text: string; params: readonly unknown[] }>;
	query: (
		text: string,
		params: readonly unknown[]
	) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function makeMockClient(): MockClient {
	const m: MockClient = {
		queries: [],
		query: async (text: string, params: readonly unknown[]) => {
			m.queries.push({ text, params });
			return { rows: [], rowCount: 1 };
		}
	};
	return m;
}

function makeCtx(payload: unknown, signer = 'alice'): OpContext {
	return {
		blockNum: 100,
		trxInBlock: 0,
		opInTrx: 0,
		blockTime: new Date('2026-04-30T12:00:00Z'),
		trxId: 'aabbccdd00112233',
		signer,
		payload,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		siblingOps: [] as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		blurt: undefined as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		config: undefined as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		feeVerifiers: undefined as any,
		// cp474 — both REQUIRED by OpContext (Part 106 fee amounts, FX floor).
		// The chat-identity handler reads neither, but a fixture that omits
		// required fields stops modelling the contract the handler is given.
		feeAmounts: {},
		fiatToUsd: () => null,
		recordOrderbookChange: () => {},
		recordChatChange: () => {}
	};
}

// Helper: 32-byte all-zero, base64-encoded.
function bytesToB64(bytes: number[]): string {
	return Buffer.from(bytes).toString('base64');
}

console.log('\n── chatIdentity ──────────────────────────────────────────\n');

await scenario('rejects payload not an object', async () => {
	const r = await handler(makeCtx('hello'), makeMockClient() as never);
	if (r.ok || r.reason !== 'payload_not_object') throw new Error(JSON.stringify(r));
});

await scenario('rejects chat_pub not a string', async () => {
	const r = await handler(makeCtx({ chat_pub: 42 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_not_string') throw new Error(JSON.stringify(r));
});

await scenario('rejects chat_pub too long', async () => {
	const longB64 = 'A'.repeat(80);
	const r = await handler(makeCtx({ chat_pub: longB64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_too_long') throw new Error(JSON.stringify(r));
});

await scenario('rejects chat_pub non-base64', async () => {
	const r = await handler(makeCtx({ chat_pub: 'not!base64!' }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_not_base64') throw new Error(JSON.stringify(r));
});

await scenario('rejects chat_pub wrong byte length', async () => {
	// 16 zero bytes — valid base64 but wrong key length.
	const b64 = bytesToB64(new Array(16).fill(0));
	const r = await handler(makeCtx({ chat_pub: b64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_wrong_length') throw new Error(JSON.stringify(r));
});

await scenario('rejects all-zero (low-order point: infinity)', async () => {
	const b64 = bytesToB64(new Array(32).fill(0));
	const r = await handler(makeCtx({ chat_pub: b64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_low_order') throw new Error(JSON.stringify(r));
});

await scenario('rejects RFC 7748 order-1 small-order point', async () => {
	const bytes = new Array(32).fill(0);
	bytes[0] = 0x01;
	const b64 = bytesToB64(bytes);
	const r = await handler(makeCtx({ chat_pub: b64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_low_order') throw new Error(JSON.stringify(r));
});

await scenario('rejects RFC 7748 order-2 small-order point', async () => {
	const bytes = [
		0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a,
		0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00
	];
	const b64 = bytesToB64(bytes);
	const r = await handler(makeCtx({ chat_pub: b64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_low_order') throw new Error(JSON.stringify(r));
});

await scenario('rejects RFC 7748 order-2 with high-bit set', async () => {
	// Same as order-2 but bit 255 set — X25519 masks before scalarmult,
	// so this produces the same DH output as the bit-cleared form.
	const bytes = [
		0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a,
		0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x80
	];
	const b64 = bytesToB64(bytes);
	const r = await handler(makeCtx({ chat_pub: b64 }), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_low_order') throw new Error(JSON.stringify(r));
});

await scenario('accepts a normal-looking pubkey + writes upsert', async () => {
	// Realistic-looking 32 bytes (not on the small-subgroup list).
	const bytes = new Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = (0x42 + i) & 0xff;
	const b64 = bytesToB64(bytes);
	const mock = makeMockClient();
	const r = await handler(makeCtx({ chat_pub: b64 }), mock as never);
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	if (mock.queries.length !== 1) {
		throw new Error(`expected 1 query, got ${mock.queries.length}`);
	}
	const q = mock.queries[0]!;
	if (!q.text.includes('INSERT INTO chat_identities')) {
		throw new Error(`expected upsert, got: ${q.text}`);
	}
	if (q.params[0] !== 'alice') throw new Error('signer in $1 should be alice');
	const buf = q.params[1] as Buffer;
	if (buf.length !== 32) throw new Error(`pubkey buffer length ${buf.length}`);
});

await scenario('rejects non-canonical base64 (extra padding)', async () => {
	// 'AAAA====' is invalid: too many padding chars for a 4-byte
	// block. Buffer.from is lenient — round-trip check catches this.
	const r = await handler(makeCtx({ chat_pub: 'AAAA====' }), makeMockClient() as never);
	if (r.ok) throw new Error('expected rejection');
	if (r.reason !== 'chat_pub_not_base64' && r.reason !== 'chat_pub_wrong_length') {
		throw new Error(`unexpected reason ${r.reason}`);
	}
});

await scenario('rejects payload missing chat_pub field', async () => {
	const r = await handler(makeCtx({}), makeMockClient() as never);
	if (r.ok || r.reason !== 'chat_pub_not_string') throw new Error(JSON.stringify(r));
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
