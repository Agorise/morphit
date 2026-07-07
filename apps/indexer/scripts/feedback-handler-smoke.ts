/**
 * Feedback handler — tsx smoke runner.
 *
 * Covers the §F.12 (G1.1) welcome-bonus gating fix: bonus
 * triggers ONLY when the feedback cites a real order_permlink
 * owned by the subject.  Without that gate, a Sybil pair could
 * sign mutual no-permlink positive feedback and each extract
 * 10 BLURT + 10 BP, with the relay also having paid the chain
 * account-creation fee (currently 100 BLURT, witness-controlled,
 * read dynamically by the relay) for each.
 *
 * Also covers a few baseline feedback handler behaviors as
 * regression coverage:
 *   - rating range (1..5)
 *   - subject is required, must be a valid account name
 *   - self-review rejection
 *   - duplicate detection
 *
 * Usage (from apps/indexer):
 *   tsx scripts/feedback-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/feedback.ts';
import { makeCtx } from '../test/testutils/context.ts';
import { makeMockClient, type QueryExpectation } from '../test/testutils/mockClient.ts';

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

function feedbackPayload(override: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		subject: 'bob',
		rating: 5,
		comment: 'great trade',
		...override
	};
}

// ─── G1.1: welcome-bonus gating on order_permlink ──────────────

await scenario('G1.1: feedback WITHOUT order_permlink does NOT trigger bonus', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const exps: QueryExpectation[] = [
		// Verified-chat conformance query runs first (ADR-0014).
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '2',
					from_subject: '2',
					span_seconds: '900',
					has_recip_flag: false
				}
			],
			rowCount: 1
		},
		// INSERT INTO feedback succeeds.
		{ match: 'INSERT INTO feedback', rows: [], rowCount: 1 }
		// Crucially: NO INSERT INTO accounts (the bonus claim) and
		// NO INSERT INTO relay_pending_transfers.  If the handler
		// were still triggering the bonus on no-permlink feedback,
		// it would query accounts here and the mock would error on
		// the unmatched query.
	];
	const mock = makeMockClient(exps);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	// Assert no SAVEPOINT for welcome_bonus was even attempted.
	const sawBonusSavepoint = mock.queries.some((q) => q.text.includes('welcome_bonus_sp'));
	if (sawBonusSavepoint) {
		throw new Error('handler attempted welcome-bonus savepoint despite no order_permlink');
	}
});

await scenario('G1.1: feedback WITH valid order_permlink DOES trigger bonus', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({
			subject: 'bob',
			order_permlink: 'order-2026-04-25-aaa'
		}),
		siblingOps: []
	});
	const exps: QueryExpectation[] = [
		// 1. Order ownership check returns a row → permlink valid.
		{ match: 'SELECT 1 FROM orders', rows: [{ '?column?': 1 }], rowCount: 1 },
		// 1b. Verified-chat conformance query (ADR-0014).
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '2',
					from_subject: '2',
					span_seconds: '900',
					has_recip_flag: false
				}
			],
			rowCount: 1
		},
		// 2. INSERT INTO feedback.
		{ match: 'INSERT INTO feedback', rows: [], rowCount: 1 },
		// 3. SAVEPOINT welcome_bonus_sp.
		{ match: 'SAVEPOINT welcome_bonus_sp', rows: [] },
		// 3.5 (Part 111). Cited order operator_tag lookup — gates
		// whether THIS instance is obligated for the welcome bonus.
		{
			match: 'FROM orders\n\t\t\t  WHERE account',
			rows: [{ operator_tag: 'morphit' }],
			rowCount: 1
		},
		// 4. UPSERT accounts — bonus claim wins (rowCount=1).
		{
			match: 'INSERT INTO accounts',
			rows: [{ name: 'bob' }],
			rowCount: 1
		},
		// 5. INSERT INTO relay_pending_transfers (the two queue rows).
		{ match: 'INSERT INTO relay_pending_transfers', rows: [], rowCount: 2 },
		// 6. RELEASE SAVEPOINT.
		{ match: 'RELEASE SAVEPOINT welcome_bonus_sp', rows: [] }
	];
	const mock = makeMockClient(exps);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	// Assert the queue insert actually fired.
	const queueInsert = mock.queries.find((q) =>
		q.text.includes('INSERT INTO relay_pending_transfers')
	);
	if (!queueInsert) throw new Error('queue insert did not fire');
});

await scenario('G1.1: feedback with order_permlink but order NOT FOUND rejects', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({
			subject: 'bob',
			order_permlink: 'order-2026-04-25-fake'
		}),
		siblingOps: []
	});
	const exps: QueryExpectation[] = [
		// Order ownership check returns no rows → permlink invalid.
		{ match: 'SELECT 1 FROM orders', rows: [], rowCount: 0 }
		// No INSERT INTO feedback, no bonus path.
	];
	const mock = makeMockClient(exps);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'order_permlink_not_found_or_unverified' }, 'result');
});

await scenario('G1.1: feedback with order_permlink owned by attacker rejects', async () => {
	// Alice signs feedback for bob, citing alice's own permlink.
	// The orderCheck WHERE account = $1 binds account to subject
	// (bob), so a permlink alice owns won't match.  This is the
	// R17 defense already in place.
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({
			subject: 'bob',
			// This permlink exists in the orders table, but for alice,
			// not bob.  The query "WHERE account = $1 AND permlink = $2"
			// with $1=bob, $2=this returns 0 rows.
			order_permlink: 'alice-order-permlink'
		}),
		siblingOps: []
	});
	const exps: QueryExpectation[] = [{ match: 'SELECT 1 FROM orders', rows: [], rowCount: 0 }];
	const mock = makeMockClient(exps);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'order_permlink_not_found_or_unverified' }, 'result');
});

await scenario(
	'Part 113 A5: feedback citing an order with fee_status != verified rejects',
	async () => {
		// Part 113 hardening — A5/B2 vector closure.  Pre-Part-113
		// the feedback handler only checked the order existed and
		// belonged to the subject.  An attacker could broadcast a
		// `morphit_order_v1` op with NO fee transfer and the row
		// would land with fee_status='missing' but still be a
		// valid citation target.  Forging citation targets was
		// effectively free.
		//
		// Now the SQL adds `AND fee_status = 'verified'` to the
		// EXISTS check; an order whose fee wasn't paid (or was
		// underpaid, or was missing) yields rowCount=0 here and
		// the handler rejects with `order_permlink_not_found_or_unverified`.
		//
		// Mock semantics: the smoke's mock query returns the rows
		// the WHERE clause WOULD match; we model "fee_status not
		// verified" by returning zero rows (correct: the WHERE in
		// the new query filters by fee_status='verified', so an
		// unverified order genuinely returns zero rows).
		const ctx = makeCtx({
			signer: 'alice',
			payload: feedbackPayload({
				subject: 'bob',
				// Bob owns this order, but its fee_status is
				// 'missing' or 'underpaid', so the verified-only
				// query returns no rows.
				order_permlink: 'bob-unverified-order'
			}),
			siblingOps: []
		});
		const exps: QueryExpectation[] = [
			{ match: 'SELECT 1 FROM orders', rows: [], rowCount: 0 }
		];
		const mock = makeMockClient(exps);
		const r = await handler(ctx, mock.client);
		assertEqual(
			r,
			{ ok: false, reason: 'order_permlink_not_found_or_unverified' },
			'result'
		);
	}
);

await scenario(
	'Part 113 A5: feedback handler SELECT query includes fee_status = verified',
	async () => {
		// Structural test: confirm the SELECT 1 FROM orders query
		// in the feedback handler is actually filtering on
		// fee_status='verified'.  Without this gate the A5 defense
		// is theoretical.
		const ctx = makeCtx({
			signer: 'alice',
			payload: feedbackPayload({
				subject: 'bob',
				order_permlink: 'order-2026-04-25-aaa'
			}),
			siblingOps: []
		});
		const exps: QueryExpectation[] = [
			{ match: 'SELECT 1 FROM orders', rows: [], rowCount: 0 }
		];
		const mock = makeMockClient(exps);
		await handler(ctx, mock.client);
		const ordersQuery = mock.queries.find((q) =>
			q.text.includes('SELECT 1 FROM orders')
		);
		if (!ordersQuery) {
			throw new Error('no SELECT 1 FROM orders query observed');
		}
		if (!ordersQuery.text.includes("fee_status = 'verified'")) {
			throw new Error(
				`orders query is missing fee_status filter; got: ${ordersQuery.text}`
			);
		}
	}
);

await scenario(
	'G1.1: feedback with valid order_permlink, but bonus already claimed, no second queue',
	async () => {
		const ctx = makeCtx({
			signer: 'alice',
			payload: feedbackPayload({
				subject: 'bob',
				order_permlink: 'order-2026-04-25-aaa'
			}),
			siblingOps: []
		});
		const exps: QueryExpectation[] = [
			{ match: 'SELECT 1 FROM orders', rows: [{ '?column?': 1 }], rowCount: 1 },
			{
				match: 'COUNT(*) FILTER (WHERE sender',
				rows: [
					{
						from_reviewer: '2',
						from_subject: '2',
						span_seconds: '900',
						has_recip_flag: false
					}
				],
				rowCount: 1
			},
			{ match: 'INSERT INTO feedback', rows: [], rowCount: 1 },
			{ match: 'SAVEPOINT welcome_bonus_sp', rows: [] },
			// Part 111 cited-order operator_tag lookup.
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			// Upsert returns rowCount=0 — bonus was already claimed.
			{ match: 'INSERT INTO accounts', rows: [], rowCount: 0 },
			// No INSERT INTO relay_pending_transfers.
			{ match: 'RELEASE SAVEPOINT welcome_bonus_sp', rows: [] }
		];
		const mock = makeMockClient(exps);
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');

		const queueInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		if (queueInsert) {
			throw new Error('queue insert fired despite bonus already claimed');
		}
	}
);

// ─── Baseline feedback handler validation (regression coverage) ─

await scenario('rejects payload that is not an object', async () => {
	const ctx = makeCtx({ signer: 'alice', payload: null, siblingOps: [] });
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects subject that is not a string', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 42 }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'subject_not_string' }, 'result');
});

await scenario('rejects subject with invalid account name', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'BAD CAPS' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'subject_invalid' }, 'result');
});

await scenario('rejects self-review', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'alice' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'self_review' }, 'result');
});

await scenario('rejects rating out of range (0)', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ rating: 0 }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'rating_out_of_range' }, 'result');
});

await scenario('rejects rating out of range (6)', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ rating: 6 }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'rating_out_of_range' }, 'result');
});

await scenario('rejects non-integer rating', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ rating: 4.5 }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'rating_out_of_range' }, 'result');
});

await scenario('rejects malformed order_permlink', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ order_permlink: 'BAD CAPS!' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'order_permlink_bad_chars' }, 'result');
});

await scenario('rejects oversize comment', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ comment: 'a'.repeat(257) }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'comment_too_long' }, 'result');
});

await scenario('rejects comment with control character', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ comment: 'hello\x07world' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'comment_forbidden_char' }, 'result');
});

// ─── §F.21 O3.3 — NFC normalization on comment ───────────────

await scenario('O3.3: NFC-normalizes comment before length check', async () => {
	// 256 NFC chars expressed as 512 codepoints decomposed.
	// Pre-fix this exceeded the 256-codepoint cap.  Post-fix the
	// NFC normalize collapses it to 256.
	const decomposed = 'e\u0301'.repeat(256);
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '2',
					from_subject: '2',
					span_seconds: '900',
					has_recip_flag: false
				}
			],
			rowCount: 1
		},
		{ match: 'INSERT INTO feedback' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				subject: 'bob',
				rating: 5,
				comment: decomposed
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO feedback'));
	const commentParam = insertCall!.params.find((p) => typeof p === 'string' && p.includes('é')) as
		| string
		| undefined;
	if (commentParam !== 'é'.repeat(256)) {
		throw new Error('comment should be NFC-normalized to 256 precomposed é');
	}
});

await scenario('O3.3: rejects bidi override in comment', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				subject: 'bob',
				rating: 4,
				comment: 'Great seller\u202E'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'comment_forbidden_char' }, 'result');
});

// ─── ADR-0014 verified-chat badge ───────────────────────────────

await scenario('ADR-0014: badge=true when 2+ in each direction, ≥15min span, no flag', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '3',
					from_subject: '4',
					span_seconds: '1800', // 30 min
					has_recip_flag: false
				}
			],
			rowCount: 1
		},
		{ match: 'INSERT INTO feedback', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
	const insert = mock.queries.find((q) => q.text.includes('INSERT INTO feedback'));
	// has_verified_chat is the 8th param (last one).
	const hvc = insert!.params[7];
	if (hvc !== true) {
		throw new Error(`expected has_verified_chat=true, got ${hvc}`);
	}
});

await scenario('cp421: gate REJECTS when only 1 message from reviewer (below verified-chat bar)', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '1',
					from_subject: '5',
					span_seconds: '1800',
					has_recip_flag: false
				}
			],
			rowCount: 1
		},
		{ match: 'INSERT INTO feedback', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	// cp421: the gate now == the verified-chat bar, so a below-bar
	// conformance (only 1 message from the reviewer) is REJECTED, not
	// stored with badge=false.
	assertEqual(r, { ok: false, reason: 'no_verified_counterparty' }, 'result');
});

await scenario('cp421: gate REJECTS when span < 15 minutes (below verified-chat bar)', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '3',
					from_subject: '4',
					span_seconds: '600', // 10 min, too fast
					has_recip_flag: false
				}
			],
			rowCount: 1
		}
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'no_verified_counterparty' }, 'result');
});

await scenario('cp421: gate REJECTS a flagged suspicious_reciprocity pair', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '5',
					from_subject: '5',
					span_seconds: '7200', // 2h — plenty
					has_recip_flag: true // but flagged
				}
			],
			rowCount: 1
		}
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'no_verified_counterparty' }, 'result');
});

await scenario('cp421: gate REJECTS when no chat messages exist (span_seconds=null)', async () => {
	const ctx = makeCtx({
		signer: 'alice',
		payload: feedbackPayload({ subject: 'bob' }),
		siblingOps: []
	});
	const mock = makeMockClient([
		{
			match: 'COUNT(*) FILTER (WHERE sender',
			rows: [
				{
					from_reviewer: '0',
					from_subject: '0',
					span_seconds: null, // pg returns NULL on empty set
					has_recip_flag: false
				}
			],
			rowCount: 1
		}
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'no_verified_counterparty' }, 'result');
});

// ─── Final report ───────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} scenarios passed`);
