/**
 * Property-based payload fuzz harness for every op handler (audit,
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
 *
 * every handler the dispatcher registers is fuzzed (a parity check
 * fails when one is added without being fuzzed); pollution keys are OWN keys,
 * as JSON.parse delivers them from the chain (`obj['__proto__'] = v` sets the
 * prototype and leaves no key at all); deep nesting and long text are seeded;
 * and known-bad values are asserted to be REJECTED, so a weakened validator
 * fails here — crash-safety alone let a removed check pass.
 */

import { describe, it, expect } from 'vitest';

import { HANDLERS as DISPATCHED } from '$indexer/dispatcher';

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
import orderComplete from '$indexer/handlers/orderComplete';
import chatFolders from '$indexer/handlers/chatFolders';
import settings from '$indexer/handlers/settings';
import block from '$indexer/handlers/block';
import featureBid from '$indexer/handlers/featureBid';
import rpcDirectory from '$indexer/handlers/rpcDirectory';

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
	release,
	orderComplete,
	chatFolders,
	settings,
	block,
	featureBid,
	rpcDirectory
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
		// An OWN key, as JSON.parse delivers it (`obj['__proto__'] = v` would
		// set the prototype instead and leave no key).
		Object.defineProperty(obj, k, {
			value: randomValue(rng, depth + 1),
			enumerable: true,
			writable: true,
			configurable: true
		});
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

describe('handler fuzz coverage and known-bad values', () => {
	it('every handler the dispatcher registers is fuzzed', () => {
		const fuzzed = new Set(Object.values(HANDLERS));
		const missing = Object.entries(DISPATCHED).filter(([, h]) => !fuzzed.has(h as never));
		expect(missing.map(([id]) => id)).toEqual([]);
	});

	const deep = (n: number): unknown => {
		let v: unknown = 'leaf';
		for (let i = 0; i < n; i++) v = { order_permlink: v, permlink: v === 'leaf' ? 'p' : undefined };
		return v;
	};
	const HOSTILE: readonly unknown[] = [
		JSON.parse('{"__proto__":{"polluted":"chain"},"display_name":"x","permlink":"p"}'),
		JSON.parse('{"constructor":{"prototype":{"polluted":"chain"}},"recipient":"bob"}'),
		JSON.parse('{"json_metadata":{"__proto__":{"polluted":"chain"}},"payment_methods":[{"__proto__":{"polluted":1}}]}'),
		deep(300),
		{ permlink: 'p', comment: 'x'.repeat(20_000), terms: 'y'.repeat(20_000), ciphertext: 'A'.repeat(20_000) }
	];

	for (const [name, handler] of Object.entries(HANDLERS)) {
		it(`${name}: own __proto__ keys, deep nesting and long text never pollute, hang or throw a non-Error`, async () => {
			for (const payload of HOSTILE) {
				try {
					const r = await withTimeout(
						Promise.resolve(handler(makeCtx({ signer: 'alice', payload }), makeMockClient().client)),
						1500,
						name
					);
					expect(isValidResultShape(r)).toBe(true);
				} catch (err) {
					expect(err).toBeInstanceOf(Error);
					expect((err as Error).message).not.toMatch(/^HANG:/);
				}
				expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			}
		});
	}

	/** The rejection reason (the SPECIFIC check must fire — a later check
	 *  rejecting for another reason would hide a removed validator). */
	const reasonFor = async (h: Handler, payload: unknown, signer = 'alice'): Promise<string> => {
		try {
			const r = (await h(makeCtx({ signer, payload }), makeMockClient().client)) as {
				ok: boolean;
				reason?: string;
			};
			return r.ok ? 'ok' : (r.reason ?? '');
		} catch (e) {
			return `threw: ${(e as Error).message}`;
		}
	};
	const goodOrder = {
		permlink: 'p1',
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 10,
		amount_max: 100,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['cash_in_person']
	};

	it('chat: a recipient that is not an account name is refused', async () => {
		expect(
			await reasonFor(chat, { recipient: 'Not An Account!', ciphertext: 'AAAA', header: { v: 1, client_tag: 't' } })
		).toBe('recipient_invalid');
	});
	it('feedback: a comment with a bidi override is refused', async () => {
		expect(await reasonFor(feedback, { subject: 'bob', rating: 5, comment: 'great \u202Etrader' })).toBe(
			'comment_forbidden_char'
		);
	});
	it('order: a negative minimum and an absurd maximum are refused', async () => {
		expect(await reasonFor(order, { ...goodOrder, amount_min: -1 })).toBe('amount_min_negative');
		expect(await reasonFor(order, { ...goodOrder, amount_max: 1e18 })).toBe('amount_max_too_large');
	});
	it("operatorBlock: anyone but this instance's operator account is refused", async () => {
		expect(
			await reasonFor(operatorBlock, { v: 1, blocked: 'bob', action: 'block', reason: 'spam' }, 'mallory')
		).toBe('not_operator');
	});
});
