/**
 * Property-based payload fuzz harness for every op handler (cp426 audit,
 * recommendation #2).
 *
 * A hostile actor can broadcast a custom_json with ANY `json` payload. Each
 * handler receives it as `unknown` and must narrow it defensively. The
 * per-handler unit tests cover known-shape rejections; this harness instead
 * throws THOUSANDS of adversarial payloads at every handler — primitives, huge
 * strings, deeply nested objects, prototype-pollution keys (__proto__,
 * constructor, prototype), wrong-typed fields, and near-miss valid shapes — and
 * asserts the crash-safety invariants that keep one bad op from wedging a block:
 *
 *   1. TERMINATES — no hang / catastrophic backtracking (bounded wall time).
 *   2. VALID RESULT SHAPE — returns {ok:true} or {ok:false, reason:string},
 *      OR throws an Error (which the dispatcher catches per-op). Never returns
 *      some other shape, never throws a non-Error.
 *   3. NO PROTOTYPE POLLUTION — a payload carrying __proto__/constructor keys
 *      never mutates Object.prototype.
 *
 * The DB client is mocked to return empty rows, so most inputs are rejected at
 * the narrowing stage before any query — exactly the path a hostile op hits.
 */

import { describe, it, expect } from 'vitest';

import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

import order from '$indexer/handlers/order';
import orderReplace from '$indexer/handlers/orderReplace';
import orderCancel from '$indexer/handlers/orderCancel';
import feedback from '$indexer/handlers/feedback';
import feedbackResponse from '$indexer/handlers/feedbackResponse';
import chat from '$indexer/handlers/chat';
import chatIdentity from '$indexer/handlers/chatIdentity';
import chatRead from '$indexer/handlers/chatRead';
import profile from '$indexer/handlers/profile';
import feeAttest from '$indexer/handlers/feeAttest';
import strangerFee from '$indexer/handlers/strangerFee';
import operatorBlock from '$indexer/handlers/operatorBlock';
import operatorPaymentMethod from '$indexer/handlers/operatorPaymentMethod';
import operatorRegister from '$indexer/handlers/operatorRegister';
import release from '$indexer/handlers/release';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: any, client: any) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
	order,
	orderReplace,
	orderCancel,
	feedback,
	feedbackResponse,
	chat,
	chatIdentity,
	chatRead,
	profile,
	feeAttest,
	strangerFee,
	operatorBlock,
	operatorPaymentMethod,
	operatorRegister,
	release
};

// ─── Deterministic PRNG ────────────────────────────────────────────
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Field names the handlers actually read — so near-miss payloads exercise the
// per-field type checks, not just the top-level object guard.
const KNOWN_FIELDS = [
	'subject', 'rating', 'comment', 'recipient', 'permlink', 'order_permlink',
	'order_account', 'ciphertext', 'chat_pub', 'blocked', 'reason', 'version',
	'action', 'key', 'name', 'description', 'tag', 'side', 'asset', 'amount_min',
	'amount_max', 'fiat_currency', 'payment_methods', 'terms', 'accepted_assets',
	'fee_method', 'network', 'address', 'treasury', 'quoted_blurt', 'v', 'txid'
];

const PRIMITIVES: readonly unknown[] = [
	null, undefined, true, false, 0, -1, 1, 3.14, NaN, Infinity, -Infinity,
	Number.MAX_SAFE_INTEGER, '', 'x', 'a'.repeat(100_000), '../../etc/passwd',
	'\u0000\u0001\u202e', '😀🔥', '{"nested":"json"}', '  ', '5' + 'A'.repeat(50)
];

function randomValue(rng: () => number, depth: number): unknown {
	if (depth > 4 || rng() < 0.5) {
		return PRIMITIVES[Math.floor(rng() * PRIMITIVES.length)];
	}
	const r = rng();
	if (r < 0.4) {
		// array
		const n = Math.floor(rng() * 6);
		return Array.from({ length: n }, () => randomValue(rng, depth + 1));
	}
	// object — sometimes seed a known field, sometimes a pollution key
	const obj: Record<string, unknown> = {};
	const n = 1 + Math.floor(rng() * 5);
	for (let i = 0; i < n; i++) {
		let k: string;
		const kr = rng();
		if (kr < 0.15) k = ['__proto__', 'constructor', 'prototype'][Math.floor(rng() * 3)]!;
		else if (kr < 0.7) k = KNOWN_FIELDS[Math.floor(rng() * KNOWN_FIELDS.length)]!;
		else k = 'k' + Math.floor(rng() * 1000);
		obj[k] = randomValue(rng, depth + 1);
	}
	return obj;
}

function isValidResultShape(r: unknown): boolean {
	if (typeof r !== 'object' || r === null) return false;
	const o = r as Record<string, unknown>;
	if (o.ok === true) return true;
	if (o.ok === false) return typeof o.reason === 'string' && o.reason.length > 0;
	return false;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error(`HANG: ${label} exceeded ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer!);
	}
}

describe('handler payload fuzz — crash-safety invariants', () => {
	for (const [name, handler] of Object.entries(HANDLERS)) {
		it(`${name}: survives 400 adversarial payloads (terminate / valid-shape / no-pollution / catchable)`, async () => {
			const rng = makeRng(0xc0ffee ^ name.length ^ (name.charCodeAt(0) << 8));
			const ITER = 400;
			const protoKeysBefore = Object.keys(Object.prototype).length;
			const badShapes: { payload: unknown; result: unknown }[] = [];
			const badThrows: { payload: unknown; err: unknown }[] = [];
			let ok = 0;
			let rejected = 0;
			let threw = 0;

			for (let i = 0; i < ITER; i++) {
				const payload = randomValue(rng, 0);
				const ctx = makeCtx({ signer: 'alice', payload });
				const client = makeMockClient().client;
				try {
					const result = await withTimeout(
						Promise.resolve(handler(ctx, client)),
						1500,
						`${name}#${i}`
					);
					if (!isValidResultShape(result)) {
						badShapes.push({ payload, result });
					} else if ((result as { ok: boolean }).ok) {
						ok++;
					} else {
						rejected++;
					}
				} catch (err) {
					// A throw is contract-acceptable (the dispatcher catches it per-op
					// with a SAVEPOINT rollback) — BUT it must be an Error instance, and
					// it must NOT be our HANG sentinel.
					threw++;
					if (!(err instanceof Error) || /^HANG:/.test((err as Error).message)) {
						badThrows.push({ payload, err });
					}
				}
			}

			// Invariant 3 — no prototype pollution from __proto__/constructor keys.
			expect(Object.keys(Object.prototype).length).toBe(protoKeysBefore);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();

			// Invariant 2 — every result was a valid shape or a catchable throw.
			if (badShapes.length > 0) {
				const b = badShapes[0]!;
				throw new Error(
					`${name} returned an INVALID result shape for ${badShapes.length}/${ITER} payloads. ` +
						`First: payload=${JSON.stringify(b.payload)?.slice(0, 200)} result=${JSON.stringify(b.result)?.slice(0, 200)}`
				);
			}
			if (badThrows.length > 0) {
				const b = badThrows[0]!;
				throw new Error(
					`${name} threw a non-Error or HUNG for ${badThrows.length}/${ITER} payloads. ` +
						`First: payload=${JSON.stringify(b.payload)?.slice(0, 200)} err=${String(b.err)}`
				);
			}

			// Sanity — the fuzz actually reached the handlers (not all no-ops).
			expect(ok + rejected + threw).toBe(ITER);
			// Random payloads are overwhelmingly invalid, so rejections must dominate.
			expect(rejected).toBeGreaterThan(0);
		});
	}
});
