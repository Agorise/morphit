/**
 * BLURT transfer verifier — pure-dispatch smoke runner.
 *
 * Exercises verifyBlurtTransferAgainstTx, the pure function
 * that takes a chain transaction and the seller's expectations
 * and returns a discriminated VerifyResult.  No network — the
 * smoke constructs mock transactions inline.
 *
 * The network wrapper (verifyBlurtTransfer) calls the same
 * dispatch logic after fetching from chain RPC; that path is
 * exercised in production but not here, since mocking the
 * BlurtClient singleton is more setup than the value warrants
 * for a smoke runner.
 */

import {
	verifyBlurtTransferAgainstTx,
	classifyRpcError,
	type ChainTxResponse,
	type VerifyExpect
} from '../../web/src/lib/chat/blurtVerify.ts';

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

/** Build a mock transfer op as the chain returns it. */
function mockTransferTx(args: {
	from: string;
	to: string;
	amount: string;
	memo: string;
	extraOps?: ReadonlyArray<[string, unknown]>;
}): ChainTxResponse {
	const transferOp: [string, unknown] = [
		'transfer',
		{
			from: args.from,
			to: args.to,
			amount: args.amount,
			memo: args.memo
		}
	];
	const ops: ReadonlyArray<[string, unknown]> = [...(args.extraOps ?? []), transferOp];
	return { operations: ops };
}

const baselineExpect: VerifyExpect = {
	recipient: 'alice',
	sender: 'bob',
	amountBlurt: 1700,
	memo: 'abc12345'
};

// ─── Verified path ───────────────────────────────────────────────

scenario('verified: all fields match', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'verified' }, 'verified');
});

scenario('verified: empty memo expected, empty memo on chain', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: ''
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: ''
	});
	assertEqual(r, { kind: 'verified' }, 'verified');
});

// ─── F-9 audit fix: empty expected memo accepts any chain memo ──

scenario('F-9: seller expected empty memo, buyer added freeform → verified', () => {
	// Seller didn't pin a memo (e.g. opted out of memo-required
	// flow).  Buyer's wallet added their own freeform memo.
	// Pre-fix: any non-empty chain memo was flagged mismatch.
	// Post-fix: empty expectation accepts anything.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'thanks alice!'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: '' // seller pinned no memo
	});
	assertEqual(r, { kind: 'verified' }, 'free buyer memo OK');
});

scenario('F-9 asymmetry: seller pinned memo, buyer omitted → STILL mismatch', () => {
	// The asymmetry: when the seller DOES pin a memo, the buyer
	// is required to use it.  Omitting is an instruction failure.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: '' // buyer omitted
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: 'abc12345' // seller required this
	});
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'still mismatch');
});

// ─── F-9 audit fix: empty expected memo accepts any chain memo ──

scenario('F-9: seller expected empty memo, buyer added freeform → verified', () => {
	// Seller didn't pin a memo (e.g. opted out of memo-required
	// flow).  Buyer's wallet added their own freeform memo.
	// Pre-fix: any non-empty chain memo was flagged mismatch.
	// Post-fix: empty expectation accepts anything.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'thanks alice!'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: '' // seller pinned no memo
	});
	assertEqual(r, { kind: 'verified' }, 'free buyer memo OK');
});

scenario('F-9 asymmetry: seller pinned memo, buyer omitted → STILL mismatch', () => {
	// The asymmetry: when the seller DOES pin a memo, the buyer
	// is required to use it.  Omitting is an instruction failure.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: '' // buyer omitted
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: 'abc12345' // seller required this
	});
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'still mismatch');
});

scenario('verified: amount within epsilon', () => {
	// BLURT 3-decimal asset, epsilon 0.0005 — 1700.0001 is
	// within tolerance.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		amountBlurt: 1700.0001
	});
	assertEqual(r, { kind: 'verified' }, 'verified');
});

// ─── F-13 audit fix: expect.amountBlurt input validation ──────────

scenario('F-13: NaN amountBlurt → mismatch:amount (defensive)', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		amountBlurt: NaN
	});
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'NaN rejected');
});

scenario('F-13: Infinity amountBlurt → mismatch:amount', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		amountBlurt: Infinity
	});
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'Infinity rejected');
});

scenario('F-13: zero amountBlurt → mismatch:amount', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		amountBlurt: 0
	});
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'zero rejected');
});

scenario('F-13: negative amountBlurt → mismatch:amount', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		amountBlurt: -1
	});
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'negative rejected');
});

// ─── Mismatch paths ──────────────────────────────────────────────

scenario('mismatch:to — transfer landed at wrong recipient', () => {
	// In our pure function, find-by-recipient fails first → wrong_op,
	// not mismatch:to.  This pins the actual behavior: when no
	// transfer in the tx targets the expected recipient, we
	// surface wrong_op so the seller knows "not for me."
	const tx = mockTransferTx({
		from: 'bob',
		to: 'eve',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'wrong_op' }, 'wrong_op');
});

scenario('mismatch:from — recipient correct but sender wrong', () => {
	// Charlie sent 1700 to Alice — same amount, same memo (which
	// is unlikely but possible if the memo collides), but not the
	// expected buyer.  Verifier flags from-mismatch.
	const tx = mockTransferTx({
		from: 'charlie',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'from' }, 'from mismatch');
});

scenario('mismatch:amount — recipient + sender match, amount off', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1500.000 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'amount mismatch');
});

scenario('mismatch:amount — outside epsilon', () => {
	// 0.001 difference exceeds 0.0005 epsilon.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.001 BLURT',
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'epsilon');
});

scenario('mismatch:amount — malformed amount string', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700 BLURT', // missing decimals
		memo: 'abc12345'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'amount' }, 'malformed');
});

scenario('mismatch:memo — buyer paid without memo', () => {
	// Real-world: buyer's wallet supports memos but they forgot
	// to paste it.  The transfer otherwise matches.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: ''
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'no memo');
});

scenario('mismatch:memo — buyer used wrong memo', () => {
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'xyz98765'
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'wrong memo');
});

// ─── Wrong-op + degenerate paths ─────────────────────────────────

scenario('wrong_op: tx has no transfer at all', () => {
	const tx: ChainTxResponse = {
		operations: [['comment', { author: 'bob', permlink: 'hello', body: 'hi' }]]
	};
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'wrong_op' }, 'wrong_op');
});

scenario('wrong_op: tx is null', () => {
	const r = verifyBlurtTransferAgainstTx(null, baselineExpect);
	assertEqual(r, { kind: 'wrong_op' }, 'wrong_op');
});

scenario('wrong_op: tx has empty operations array', () => {
	const r = verifyBlurtTransferAgainstTx({ operations: [] }, baselineExpect);
	assertEqual(r, { kind: 'wrong_op' }, 'wrong_op');
});

scenario('wrong_op: operations field undefined', () => {
	const r = verifyBlurtTransferAgainstTx({ operations: undefined }, baselineExpect);
	assertEqual(r, { kind: 'wrong_op' }, 'wrong_op');
});

// ─── Bundled-ops path ────────────────────────────────────────────

scenario('verified: transfer is one of several ops in the tx', () => {
	// Real chain bundling: a custom_json + a transfer in the same
	// transaction.  The verifier finds the transfer by walking
	// the ops list.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'abc12345',
		extraOps: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['bob'],
					id: 'morphit_chat_v1',
					json: '{}'
				}
			]
		]
	});
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'verified' }, 'verified despite bundled custom_json');
});

scenario('verified: picks correct transfer when multiple exist', () => {
	// Hypothetical: same tx contains two transfers, one to alice
	// (legitimate) and one to charlie (parasitic / unrelated).
	// The verifier finds the alice-bound one and checks it.
	const aliceTransfer: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'alice',
			amount: '1700.000 BLURT',
			memo: 'abc12345'
		}
	];
	const charlieTransfer: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'charlie',
			amount: '50.000 BLURT',
			memo: 'gift'
		}
	];
	const tx: ChainTxResponse = {
		operations: [charlieTransfer, aliceTransfer]
	};
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'verified' }, 'verified — correct transfer matched');
});

// ─── F-7 fix: multi-transfer-to-recipient handling ────────────────

scenario('F-7: decoy alice-transfer before legit alice-transfer → verified', () => {
	// Critical attack scenario: a hostile buyer crafts a transaction
	// with a small "decoy" transfer to alice ahead of the real
	// payment.  Pre-fix, the verifier picked up the decoy and
	// flagged mismatch.  Post-fix, it scans all alice-bound
	// transfers and finds the legitimate one.
	const decoy: [string, unknown] = [
		'transfer',
		{ from: 'bob', to: 'alice', amount: '1.000 BLURT', memo: 'dust' }
	];
	const legit: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'alice',
			amount: '1700.000 BLURT',
			memo: 'abc12345'
		}
	];
	const tx: ChainTxResponse = { operations: [decoy, legit] };
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'verified' }, 'finds legit despite decoy');
});

scenario('F-7: legit alice-transfer before decoy → verified (order-independent)', () => {
	// Reverse order — the verifier must not have a bias toward
	// "first" or "last" transfer; either way, if any matches, we
	// verify.
	const legit: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'alice',
			amount: '1700.000 BLURT',
			memo: 'abc12345'
		}
	];
	const decoy: [string, unknown] = [
		'transfer',
		{ from: 'bob', to: 'alice', amount: '1.000 BLURT', memo: 'dust' }
	];
	const tx: ChainTxResponse = { operations: [legit, decoy] };
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'verified' }, 'finds legit regardless of order');
});

scenario('F-7: two alice-transfers, neither matches → reports closest-field mismatch', () => {
	// Both transfers go to alice, neither matches expectations.
	// Verifier reports the first-failed field of the candidate
	// with the fewest mismatches.  Here both have wrong memo only;
	// we expect mismatch:memo.
	const t1: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'alice',
			amount: '1700.000 BLURT',
			memo: 'wrong001'
		}
	];
	const t2: [string, unknown] = [
		'transfer',
		{
			from: 'bob',
			to: 'alice',
			amount: '1700.000 BLURT',
			memo: 'wrong002'
		}
	];
	const tx: ChainTxResponse = { operations: [t1, t2] };
	const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'closest field');
});

scenario(
	'F-7: two alice-transfers, one with right memo wrong amount, one with right amount wrong memo → mismatch reports closest',
	() => {
		// Neither candidate fully matches.  Each has exactly one wrong
		// field.  Tie on mismatch count → first-encountered wins for
		// reporting.  Either 'amount' or 'memo' acceptable; current
		// implementation picks the first one's failure field.
		const t1: [string, unknown] = [
			'transfer',
			{
				from: 'bob',
				to: 'alice',
				amount: '1.000 BLURT', // wrong amount
				memo: 'abc12345' // right memo
			}
		];
		const t2: [string, unknown] = [
			'transfer',
			{
				from: 'bob',
				to: 'alice',
				amount: '1700.000 BLURT', // right amount
				memo: 'wrongmemo' // wrong memo
			}
		];
		const tx: ChainTxResponse = { operations: [t1, t2] };
		const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
		// The first-encountered candidate (t1) has 'amount' as its
		// failed field.  Verifier reports it.  Both single-mismatch,
		// no tie-breaking promised — either field would be a valid
		// outcome.  We assert it's a mismatch (not verified) and the
		// field is one of the two we expect.
		if (r.kind !== 'mismatch') {
			throw new Error(`expected mismatch, got ${r.kind}`);
		}
		if (r.field !== 'amount' && r.field !== 'memo') {
			throw new Error(`expected amount or memo, got ${r.field}`);
		}
	}
);

scenario(
	'F-7: alice-transfer with sender mismatch + bob-transfer with sender match → mismatch (only alice-targets evaluated)',
	() => {
		// A transfer to alice from charlie (wrong sender) shouldn't
		// pass even if there's a separate transfer from bob to someone
		// else.  Only `to: alice` candidates count.
		const fromCharlieToAlice: [string, unknown] = [
			'transfer',
			{
				from: 'charlie',
				to: 'alice',
				amount: '1700.000 BLURT',
				memo: 'abc12345'
			}
		];
		const fromBobToCharlie: [string, unknown] = [
			'transfer',
			{
				from: 'bob',
				to: 'charlie',
				amount: '1700.000 BLURT',
				memo: 'abc12345'
			}
		];
		const tx: ChainTxResponse = {
			operations: [fromCharlieToAlice, fromBobToCharlie]
		};
		const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
		assertEqual(r, { kind: 'mismatch', field: 'from' }, 'wrong sender on alice-transfer');
	}
);

scenario(
	'F-7: legitimate bundle of two transfers to alice, second is the trade payment → verified',
	() => {
		// Real-world legitimate case: a buyer who has an unrelated
		// gift to alice bundles with the trade payment.  Both go to
		// alice but only one matches the trade's memo.  Verifier
		// finds the matching one.
		const giftFromBob: [string, unknown] = [
			'transfer',
			{
				from: 'bob',
				to: 'alice',
				amount: '5.000 BLURT',
				memo: 'thanks for the help'
			}
		];
		const tradePayment: [string, unknown] = [
			'transfer',
			{
				from: 'bob',
				to: 'alice',
				amount: '1700.000 BLURT',
				memo: 'abc12345'
			}
		];
		const tx: ChainTxResponse = { operations: [giftFromBob, tradePayment] };
		const r = verifyBlurtTransferAgainstTx(tx, baselineExpect);
		assertEqual(r, { kind: 'verified' }, 'finds trade payment in legitimate bundle');
	}
);

// ─── Sanity: malformed expected memo ─────────────────────────────

scenario('mismatch:memo — expected memo is malformed', () => {
	// If the seller's expected memo somehow ended up out of shape
	// (decoder should have caught this, but defense in depth),
	// surface as memo mismatch rather than verified-when-broken.
	const tx = mockTransferTx({
		from: 'bob',
		to: 'alice',
		amount: '1700.000 BLURT',
		memo: 'whatever'
	});
	const r = verifyBlurtTransferAgainstTx(tx, {
		...baselineExpect,
		memo: 'BAD!' // uppercase + special char + too short
	});
	assertEqual(r, { kind: 'mismatch', field: 'memo' }, 'malformed expected');
});

// ─── F-10 audit fix: classifyRpcError tighter heuristic ───────────

scenario('F-10: "Transaction not found" → not_found', () => {
	assertEqual(classifyRpcError('Transaction not found'), 'not_found', 'std msg');
});

scenario('F-10: "Could not find transaction matching hash" → not_found', () => {
	assertEqual(
		classifyRpcError('Could not find transaction matching hash abc123'),
		'not_found',
		'verbose form'
	);
});

scenario('F-10: "Unknown transaction" → not_found', () => {
	assertEqual(classifyRpcError('Unknown transaction'), 'not_found', 'unknown variant');
});

scenario('F-10: "trx_id not found" → not_found', () => {
	// Some Blurt nodes use "trx_id" rather than "transaction".
	assertEqual(classifyRpcError('trx_id not found in chain'), 'not_found', 'trx_id form');
});

scenario('F-10: "host not found" → other (NETWORK error, not chain)', () => {
	// Pre-fix this matched not_found regex and was misclassified.
	// A DNS / connectivity failure isn't proof the tx isn't on chain.
	assertEqual(
		classifyRpcError('getaddrinfo ENOTFOUND host not found'),
		'other',
		'DNS error not misclassified'
	);
});

scenario('F-10: "DNS not found" → other', () => {
	assertEqual(
		classifyRpcError('DNS lookup failed: not found'),
		'other',
		'DNS error not misclassified'
	);
});

scenario('F-10: generic "rpc failed" → other', () => {
	assertEqual(classifyRpcError('rpc failed'), 'other', 'generic error');
});

scenario('F-10: "missing transaction" → not_found', () => {
	assertEqual(classifyRpcError('missing transaction'), 'not_found', 'missing variant');
});

scenario('F-10: "no such transaction" → not_found', () => {
	assertEqual(classifyRpcError('no such transaction'), 'not_found', 'no such variant');
});

scenario('F-10: Blurt-RPC verbose error → not_found', () => {
	// Real-world example from Blurt nodes, paraphrased.
	const msg = 'Transaction matching hash abc not found in any block of the past 24 hours';
	assertEqual(classifyRpcError(msg), 'not_found', 'verbose Blurt error');
});

scenario('F-10: case-insensitive matching', () => {
	assertEqual(classifyRpcError('TRANSACTION NOT FOUND'), 'not_found', 'uppercase');
});

scenario('F-10: "connection refused" → other', () => {
	assertEqual(classifyRpcError('connection refused'), 'other', 'network error');
});

// ─── F-10 audit fix: classifyRpcError tighter heuristic ───────────

scenario('F-10: "Transaction not found" → not_found', () => {
	assertEqual(classifyRpcError('Transaction not found'), 'not_found', 'std msg');
});

scenario('F-10: "Could not find transaction matching hash" → not_found', () => {
	assertEqual(
		classifyRpcError('Could not find transaction matching hash abc123'),
		'not_found',
		'verbose form'
	);
});

scenario('F-10: "Unknown transaction" → not_found', () => {
	assertEqual(classifyRpcError('Unknown transaction'), 'not_found', 'unknown variant');
});

scenario('F-10: "trx_id not found" → not_found', () => {
	// Some Blurt nodes use "trx_id" rather than "transaction".
	assertEqual(classifyRpcError('trx_id not found in chain'), 'not_found', 'trx_id form');
});

scenario('F-10: "host not found" → other (NETWORK error, not chain)', () => {
	// Pre-fix this matched not_found regex and was misclassified.
	// A DNS / connectivity failure isn't proof the tx isn't on chain.
	assertEqual(
		classifyRpcError('getaddrinfo ENOTFOUND host not found'),
		'other',
		'DNS error not misclassified'
	);
});

scenario('F-10: "DNS not found" → other', () => {
	assertEqual(
		classifyRpcError('DNS lookup failed: not found'),
		'other',
		'DNS error not misclassified'
	);
});

scenario('F-10: generic "rpc failed" → other', () => {
	assertEqual(classifyRpcError('rpc failed'), 'other', 'generic error');
});

scenario('F-10: "missing transaction" → not_found', () => {
	assertEqual(classifyRpcError('missing transaction'), 'not_found', 'missing variant');
});

scenario('F-10: "no such transaction" → not_found', () => {
	assertEqual(classifyRpcError('no such transaction'), 'not_found', 'no such variant');
});

scenario('F-10: Blurt-RPC verbose error → not_found', () => {
	// Real-world example from Blurt nodes, paraphrased.
	const msg = 'Transaction matching hash abc not found in any block of the past 24 hours';
	assertEqual(classifyRpcError(msg), 'not_found', 'verbose Blurt error');
});

scenario('F-10: case-insensitive matching', () => {
	assertEqual(classifyRpcError('TRANSACTION NOT FOUND'), 'not_found', 'uppercase');
});

scenario('F-10: "connection refused" → other', () => {
	assertEqual(classifyRpcError('connection refused'), 'other', 'network error');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
