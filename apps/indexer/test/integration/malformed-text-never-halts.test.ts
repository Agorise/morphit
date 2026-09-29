/**
 * v1.20.0 (V3-11) — a NUL or an unpaired surrogate in chain data must never
 * halt the indexer.
 *
 * Postgres cannot store U+0000 in TEXT, nor a `\u0000` or unpaired-surrogate
 * escape in JSONB. One Morphit custom_json carrying `"hi\u0000"`, or one tiny
 * transfer to the fee account with a NUL in its memo, failed the block's
 * event-log / fee_transfers INSERT; the block rolled back and the poller
 * retried it forever — every indexer halted at that block.
 *
 * Proven here against real Postgres:
 *   1. V3's two cases through the real dispatcher (applyBlock);
 *   2. the same two blocks through the real Poller (tick → getBlocks →
 *      applyWindow → markApplied): the cursor moves past them;
 *   3. a seeded fuzz over EVERY registered op id plus transfers, account
 *      creates and key rotations, with NUL / surrogate-laden strings in
 *      values, keys, signers, memos and names, raw and escaped: every block
 *      applies, every Morphit op is recorded exactly once, every payload that
 *      held such text is rejected `invalid_text`, and two independent nodes
 *      store byte-identical rows.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock, OP_IDS } from '../../src/indexer/dispatcher';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import { reconcileOperatorRegistrations } from '../../src/indexer/reconcileRegistrations';
import { isPgSafeText, pgSafeDeep } from '../../src/db/pgText';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

/** A chain client that answers only what a block apply may ask: one reachable
 *  operator (so a fee-relevant block is applied single-source, as documented). */
const blurt = () => mockBlurt({ reachableOperatorCount: () => 1 });

type Op = [string, unknown];
function block(ops: Op[], ts = '2026-10-01T00:00:00'): unknown {
	return {
		timestamp: ts,
		transaction_ids: ops.map((_, i) => `t${i}`),
		transactions: ops.map((op) => ({ operations: [op] }))
	};
}

async function apply(fx: IntegrationFixture, n: number, b: unknown): Promise<void> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			n,
			b as never,
			blurt(),
			fakeConfig({}),
			{},
			{},
			((a: number) => a) as never
		);
		await c.query('COMMIT');
	} catch (e) {
		await c.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		c.release();
	}
}

/** V3's two blocks, verbatim. */
const nulChat = (): Op => [
	'custom_json',
	{
		required_auths: [],
		required_posting_auths: ['eve'],
		id: 'morphit_chat_v1',
		json: '{"to":"bob","m":"hi\\u0000"}'
	}
];
const nulMemo = (): Op => [
	'transfer',
	{ from: 'eve', to: 'morphit-fees', amount: '0.001 BLURT', memo: 'x\u0000y' }
];

describe.skipIf(!INTEGRATION_ENABLED)('V3-11: malformed text never halts block processing', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('a custom_json whose JSON carries \\u0000 is recorded as rejected, and the block applies', async () => {
		await expect(
			apply(fx, 5, block([nulChat()])),
			'the block was rolled back'
		).resolves.toBeUndefined();
		const r = await fx.db.query<{ status: string; reject_reason: string; m: string }>(
			`SELECT status, reject_reason, payload->>'m' AS m FROM ops WHERE block_num = 5`
		);
		expect(r.rows).toEqual([{ status: 'rejected', reject_reason: 'invalid_text', m: 'hi\uFFFD' }]);
	});

	it('a fee-account transfer with a NUL in its memo is recorded with U+FFFD, and the block applies', async () => {
		await expect(
			apply(fx, 6, block([nulMemo()])),
			'the block was rolled back'
		).resolves.toBeUndefined();
		const r = await fx.db.query<{ memo: string; memo_permlink: string | null }>(
			'SELECT memo, memo_permlink FROM fee_transfers WHERE block_num = 6'
		);
		expect(r.rows).toEqual([{ memo: 'x\uFFFDy', memo_permlink: null }]);
	});

	it('an unpaired surrogate escape, a raw NUL in the JSON text and a NUL in a key are handled too', async () => {
		const cj = (json: string): Op => [
			'custom_json',
			{ required_auths: [], required_posting_auths: ['eve'], id: 'morphit_profile_v1', json }
		];
		await apply(
			fx,
			7,
			block([cj('{"display_name":"\\ud800x"}'), cj('{"about":"a\u0000b"}'), cj('{"a\\u0000":1}')])
		);
		const r = await fx.db.query<{
			op_in_trx: number;
			trx_in_block: number;
			status: string;
			reject_reason: string;
		}>(
			`SELECT trx_in_block, op_in_trx, status, reject_reason FROM ops WHERE block_num = 7 ORDER BY trx_in_block`
		);
		expect(r.rows.map((x) => [x.trx_in_block, x.status, x.reject_reason])).toEqual([
			[0, 'rejected', 'invalid_text'],
			// A raw NUL in the JSON text: what the signer wrote is not storable.
			[1, 'rejected', 'invalid_text'],
			[2, 'rejected', 'invalid_text']
		]);
	});

	it('through the real Poller: the cursor moves past both of V3’s blocks', async () => {
		const blocks = new Map<number, unknown>([
			[101, block([nulChat()], '2026-10-01T00:01:00')],
			[102, block([nulMemo()], '2026-10-01T00:01:03')]
		]);
		const chain = mockBlurt({
			reachableOperatorCount: () => 1,
			endpointCount: () => 1,
			healthyEndpointCount: () => 1,
			fastestLatencyMs: () => 1,
			getDynamicGlobalProperties: async () =>
				({ head_block_number: 102, last_irreversible_block_num: 102 }) as never,
			crossCheckChainConsistency: async () =>
				({ consistent: true, reason: 'ok', agreeing: 1, contacted: 1, required: 1 }) as never,
			getBlocks: (async (nums: readonly number[]) =>
				nums.map((n) => blocks.get(n) ?? null)) as never
		});
		// The REAL config loader, so the Poller gets every field it reads.
		const saved = { ...process.env };
		Object.assign(process.env, {
			MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
			MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
			MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
			MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
			MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
			MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
				'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
			MORPHIT_INDEXER_BACKFILL_MODE: 'fifo',
			MORPHIT_INDEXER_BACKFILL_CONCURRENCY: '1'
		});
		const config = (() => {
			try {
				return loadConfig();
			} finally {
				process.env = saved;
			}
		})();
		await fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 100, $1)
			 ON CONFLICT (id) DO UPDATE SET last_applied_block = 100`,
			[config.chainId]
		);
		const poller = new Poller(config, fx.db, chain, null, null);
		const p = poller as unknown as { status: { indexedBlock: number }; tick(): Promise<void> };
		p.status = { ...p.status, indexedBlock: 100 };
		await p.tick();
		expect(poller.getStatus().indexedBlock, 'the poller is stuck behind a malformed block').toBe(
			102
		);
		const st = await fx.db.query<{ n: string }>(
			'SELECT last_applied_block::text AS n FROM indexer_state WHERE id = 1'
		);
		expect(st.rows[0]?.n).toBe('102');
	});
});

// ─── Fuzz ────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	'a',
	'Z',
	'9',
	'-',
	' ',
	'é',
	'😀',
	'\u0000',
	'\uD800',
	'\uDC00',
	'\uDBFF',
	'\uDFFF',
	'\\',
	'"',
	'\u0001',
	'morphit-fee:',
	'p1',
	'bob',
	'\uFFFD'
];

function fuzzer(seed: number) {
	const rnd = mulberry32(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
	const str = (): string => {
		let s = '';
		const n = Math.floor(rnd() * 8);
		for (let i = 0; i < n; i++) s += pick(PIECES);
		return s;
	};
	const value = (depth: number): unknown => {
		const r = rnd();
		if (depth <= 0 || r < 0.4) return str();
		if (r < 0.5) return Math.floor(rnd() * 1000);
		if (r < 0.55) return rnd() < 0.5;
		if (r < 0.6) return null;
		if (r < 0.8) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth - 1));
		const o: Record<string, unknown> = {};
		for (let i = Math.floor(rnd() * 5); i > 0; i--)
			o[rnd() < 0.7 ? pick(['permlink', 'to', 'm', 'side', 'origin', 'tag']) : str()] = value(
				depth - 1
			);
		return o;
	};
	const account = (): string =>
		rnd() < 0.8 ? pick(['alice', 'bob', 'eve']) : `al${pick(PIECES)}ice`;
	const op = (): Op => {
		const r = rnd();
		if (r < 0.7) {
			const payload = value(3);
			let json = JSON.stringify(payload) ?? 'null';
			// Sometimes a raw NUL or a raw lone surrogate in the JSON text itself.
			if (rnd() < 0.1)
				json = json.slice(0, 1) + pick(['\u0000', '\uD800', '\uDC00']) + json.slice(1);
			const active = rnd() < 0.15;
			return [
				'custom_json',
				{
					required_auths: active ? [account()] : [],
					required_posting_auths: active ? [] : [account()],
					id: pick(Object.values(OP_IDS)),
					json
				}
			];
		}
		if (r < 0.85)
			return [
				'transfer',
				{
					from: account(),
					to: pick(['morphit-fees', 'bob']),
					amount: pick(['0.001 BLURT', '62.500 BLURT', 'x']),
					memo: str()
				}
			];
		if (r < 0.93)
			return [
				'account_create',
				{
					creator: account(),
					new_account_name: `n${str()}`,
					posting: { weight_threshold: 1, key_auths: [[`BLT${str()}`, 1]] },
					json_metadata: str()
				}
			];
		return [
			'account_update',
			{ account: account(), posting: { weight_threshold: 1, key_auths: [[`BLT${str()}`, 1]] } }
		];
	};
	return { op, rnd };
}

function fuzzBlocks(
	seed: number,
	count: number
): { n: number; b: { transactions: { operations: Op[] }[] } }[] {
	const f = fuzzer(seed);
	const out = [];
	for (let i = 0; i < count; i++) {
		const ops = Array.from({ length: 1 + Math.floor(f.rnd() * 6) }, () => f.op());
		out.push({
			n: 1000 + i,
			b: block(
				ops,
				`2026-10-02T00:${String(Math.floor(i / 20)).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}`
			) as never
		});
	}
	return out;
}

const hasBadText = (v: unknown): boolean => pgSafeDeep(v) !== v;

describe.skipIf(!INTEGRATION_ENABLED)('V3-11 fuzz: every op id, every text-bearing field', () => {
	let a: IntegrationFixture;
	let b: IntegrationFixture;
	beforeAll(async () => {
		a = await setupWithMigrations();
		b = await setupWithMigrations();
	});
	afterAll(async () => {
		await a?.teardown();
		await b?.teardown();
	});

	it('never halts, records every Morphit op once, rejects every malformed payload, and two nodes agree', async () => {
		const blocks = fuzzBlocks(0x5eed_1511, 120);
		let malformed = 0;
		for (const { n, b: blk } of blocks) {
			await expect(apply(a, n, blk), `block ${n} halted node A`).resolves.toBeUndefined();
			await expect(apply(b, n, blk), `block ${n} halted node B`).resolves.toBeUndefined();
		}
		// Every located Morphit op has exactly one event-log row, and every
		// payload that held NUL / an unpaired surrogate was rejected for it.
		const rows = await a.db.query<{
			block_num: string;
			trx_in_block: number;
			status: string;
			reject_reason: string | null;
			payload: unknown;
			signer: string;
		}>(
			'SELECT block_num::text, trx_in_block, status, reject_reason, payload, signer FROM ops WHERE block_num >= 1000'
		);
		const byPos = new Map(rows.rows.map((r) => [`${r.block_num}:${r.trx_in_block}`, r]));
		const seenIds = new Set<string>();
		let expected = 0;
		for (const { n, b: blk } of blocks) {
			blk.transactions.forEach((t, ti) => {
				const [name, body] = t.operations[0]!;
				if (name !== 'custom_json') return;
				const cj = body as { id: string; json: string };
				expected++;
				const row = byPos.get(`${n}:${ti}`);
				expect(row, `block ${n} trx ${ti}: no event-log row`).toBeDefined();
				expect(isPgSafeText(JSON.stringify(row!.payload)) && isPgSafeText(row!.signer)).toBe(true);
				seenIds.add(cj.id);
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(pgSafeDeep(cj.json));
				} catch {
					// malformed JSON: rejected as such unless its own text was bad
				}
				const signerRejected =
					row!.reject_reason === 'active_auth_not_allowed' ||
					row!.reject_reason === 'no_posting_auth';
				if ((hasBadText(body) || hasBadText(parsed)) && !signerRejected) {
					malformed++;
					expect(row!.status, `block ${n} trx ${ti}`).toBe('rejected');
					expect(row!.reject_reason, `block ${n} trx ${ti}`).toBe('invalid_text');
				}
			});
		}
		expect(rows.rowCount).toBe(expected);
		expect([...seenIds].sort(), 'the fuzz must reach every registered op id').toEqual(
			Object.values(OP_IDS).sort()
		);
		expect(malformed, 'the fuzz must actually exercise malformed payloads').toBeGreaterThan(20);

		// Two independent nodes store exactly the same thing.
		for (const [table, order] of [
			['ops', 'block_num, trx_in_block, op_in_trx'],
			['fee_transfers', 'block_num, trx_in_block, op_in_trx'],
			['accounts', 'name']
		] as const) {
			const q = `SELECT * FROM ${table} ORDER BY ${order}`;
			const [ra, rb] = await Promise.all([a.db.query(q), b.db.query(q)]);
			expect(JSON.stringify(rb.rows), `${table} differs between two nodes`).toBe(
				JSON.stringify(ra.rows)
			);
		}
	}, 120_000);
});

describe.skipIf(!INTEGRATION_ENABLED)(
	'V3-11: an invalid_text rejection is never healed on reboot',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});

		it('reconcileOperatorRegistrations does not replay a register op rejected for invalid_text', async () => {
			// The dispatcher's own record of a register op whose origin held a NUL.
			const payload = JSON.stringify({ v: 1, tag: 'nul', origin: 'https://x\uFFFD.example' });
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
			 VALUES (9, 0, 0, now(), 't', 'eve', $1, $2::jsonb, 'rejected', 'invalid_text')`,
				[OP_IDS.operatorRegister, payload]
			);
			let replayed = 0;
			await reconcileOperatorRegistrations({
				db: fx.db,
				blurt: mockBlurt({}),
				config: fakeConfig({}),
				feeVerifiers: {},
				feeAmounts: {},
				fiatToUsd: () => null,
				handler: async () => {
					replayed++;
					return { ok: true };
				}
			} as never);
			expect(replayed, 'a U+FFFD copy of an unsignable payload was replayed into state').toBe(0);
		});
	}
);
