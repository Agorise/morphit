/**
 * tradeStatus pure-logic smoke runner.
 *
 * Exercises advancePhase + phaseForVerify + the pure mutators
 * without touching the Svelte-store wrapper, so tsx can run
 * it without resolving 'svelte/store'.
 *
 * Coverage targets:
 *   - Phase monotonic advancement
 *   - paid_verified stickiness against later mismatch / unverifiable
 *   - phaseForVerify mapping for every VerifyResult variant
 *   - recordAddressSharedPure round-trip
 *   - recordFundsSentPure preserves expectedMemo from prior address pill
 *   - recordVerificationPure transitions phase + clears mismatch on verified
 *   - Future-phase preservation (released/disputed/completed don't regress)
 *   - Unknown phase handling (defensive)
 */

import {
	advancePhase,
	phaseForVerify,
	recordAddressSharedPure,
	recordFundsSentPure,
	recordVerificationPure,
	type TradePhase,
	type TradeState
} from '../../web/src/lib/trades/tradeStatusPure.ts';
import type { VerifyResult } from '../../web/src/lib/chat/blurtVerify.ts';

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
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assertTrue(cond: boolean, label: string): void {
	if (!cond) throw new Error(`${label}: expected true`);
}

const empty: ReadonlyMap<string, TradeState> = new Map();

// ─── advancePhase ─────────────────────────────────────────────────

scenario('advancePhase: undefined → candidate', () => {
	assertEqual(advancePhase(undefined, 'address_shared'), 'address_shared', 'a');
	assertEqual(advancePhase(undefined, 'paid'), 'paid', 'b');
});

scenario('advancePhase: forward progress', () => {
	assertEqual(advancePhase('address_shared', 'paid'), 'paid', 'shared → paid');
	assertEqual(advancePhase('paid', 'paid_verified'), 'paid_verified', 'paid → verified');
	assertEqual(advancePhase('paid', 'paid_mismatch'), 'paid_mismatch', 'paid → mismatch');
});

scenario('advancePhase: no regression', () => {
	assertEqual(advancePhase('paid', 'address_shared'), 'paid', 'paid stays');
	assertEqual(advancePhase('paid_verified', 'paid'), 'paid_verified', 'verified stays');
});

scenario('advancePhase: paid_verified is sticky against mismatch', () => {
	assertEqual(
		advancePhase('paid_verified', 'paid_mismatch'),
		'paid_verified',
		'sticky vs mismatch'
	);
});

scenario('advancePhase: paid_verified is sticky against unverifiable', () => {
	assertEqual(
		advancePhase('paid_verified', 'paid_unverifiable'),
		'paid_verified',
		'sticky vs unverifiable'
	);
});

scenario('advancePhase: paid_mismatch can still advance to released/etc', () => {
	// A mismatched payment may later be released by mediation.
	assertEqual(advancePhase('paid_mismatch', 'released'), 'released', 'mismatch → released');
});

scenario('advancePhase: unknown candidate returns current', () => {
	// Forward-compat: a future protocol phase we don't recognize
	// in this client shouldn't crash.  Fall back to current.
	const r = advancePhase('paid', 'cosmic_settlement' as TradePhase);
	assertEqual(r, 'paid', 'unknown stays current');
});

// ─── phaseForVerify ───────────────────────────────────────────────

scenario('phaseForVerify: verified → paid_verified', () => {
	assertEqual(phaseForVerify({ kind: 'verified' }), 'paid_verified', 'v');
});

scenario('phaseForVerify: mismatch → paid_mismatch', () => {
	assertEqual(phaseForVerify({ kind: 'mismatch', field: 'amount' }), 'paid_mismatch', 'm');
});

scenario('phaseForVerify: not_found → paid_unverifiable', () => {
	assertEqual(phaseForVerify({ kind: 'not_found' }), 'paid_unverifiable', 'nf');
});

scenario('phaseForVerify: wrong_op → paid_unverifiable', () => {
	assertEqual(phaseForVerify({ kind: 'wrong_op' }), 'paid_unverifiable', 'wo');
});

scenario('phaseForVerify: rpc_error → paid_unverifiable', () => {
	assertEqual(phaseForVerify({ kind: 'rpc_error', message: 'down' }), 'paid_unverifiable', 're');
});

// Phase F.5 audit fix (F-42) — forward-compat for a future
// VerifyResult kind that this client doesn't recognize.  Should
// fall through to paid_unverifiable rather than crash or return
// an undefined phase.
scenario('phaseForVerify: unknown future kind → paid_unverifiable', () => {
	const futureResult = { kind: 'rate_limited' } as unknown as Parameters<typeof phaseForVerify>[0];
	assertEqual(phaseForVerify(futureResult), 'paid_unverifiable', 'fwd-compat');
});

// Phase F.5 audit fix (F-42) — forward-compat for a future
// VerifyResult kind that this client doesn't recognize.  Should
// fall through to paid_unverifiable rather than crash or return
// an undefined phase.
scenario('phaseForVerify: unknown future kind → paid_unverifiable', () => {
	const futureResult = { kind: 'rate_limited' } as unknown as Parameters<typeof phaseForVerify>[0];
	assertEqual(phaseForVerify(futureResult), 'paid_unverifiable', 'fwd-compat');
});

// ─── recordAddressSharedPure ──────────────────────────────────────

scenario('recordAddressSharedPure: creates entry', () => {
	const next = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedAmount: 1700,
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	const entry = next.get('ord-1');
	assertTrue(entry !== undefined, 'entry exists');
	assertEqual(entry?.phase, 'address_shared', 'phase');
	assertEqual(entry?.expectedMemo, 'abc12345', 'memo');
	assertEqual(entry?.expectedAmount, 1700, 'amount');
	assertEqual(entry?.peer, 'bob', 'peer');
});

scenario('recordAddressSharedPure: preserves addressSharedAt on re-record', () => {
	const t0 = new Date('2026-01-01T00:00:00Z');
	const t1 = new Date('2026-01-01T01:00:00Z');
	const a = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		now: t0,
		direction: 'outgoing'
	});
	const b = recordAddressSharedPure(a, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		now: t1,
		direction: 'outgoing'
	});
	const entry = b.get('ord-1');
	assertEqual(entry?.addressSharedAt?.toISOString(), t0.toISOString(), 'preserved');
	assertEqual(entry?.updatedAt?.toISOString(), t1.toISOString(), 'updatedAt advances');
});

// ─── recordFundsSentPure ──────────────────────────────────────────

scenario('recordFundsSentPure: preserves expectedMemo from prior address', () => {
	let m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedAmount: 1700,
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	m = recordFundsSentPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		claimedMemo: 'WRONG999',
		amount: 1700,
		direction: 'outgoing'
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.expectedMemo, 'abc12345', 'expected preserved');
	assertEqual(entry?.claimedMemo, 'WRONG999', 'claimed recorded');
	assertEqual(entry?.phase, 'paid', 'phase advanced');
});

scenario('recordFundsSentPure: BLURT sets verifyResult to pending', () => {
	const m = recordFundsSentPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 1700,
		direction: 'outgoing'
	});
	assertEqual(m.get('ord-1')?.verifyResult, 'pending', 'pending');
});

scenario('recordFundsSentPure: BTC has no verifyResult', () => {
	const m = recordFundsSentPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'btc',
		txid: 'a'.repeat(64),
		amount: 0.5,
		direction: 'outgoing'
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.verifyResult, undefined, 'no verify for BTC');
});

scenario('recordFundsSentPure: creates entry even without prior address pill', () => {
	const m = recordFundsSentPure(empty, {
		orderPermlink: 'ord-orphan',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 100,
		direction: 'outgoing'
	});
	const entry = m.get('ord-orphan');
	assertTrue(entry !== undefined, 'created');
	assertEqual(entry?.phase, 'paid', 'phase');
	assertEqual(entry?.expectedAmount, 100, 'amount captured from funds_sent');
});

// ─── recordVerificationPure ───────────────────────────────────────

scenario('recordVerificationPure: first-wins between sibling terminals', () => {
	let m = recordFundsSentPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 1700,
		direction: 'outgoing'
	});
	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'mismatch', field: 'memo' }
	});
	assertEqual(m.get('ord-1')?.mismatchField, 'memo', 'mismatch field set');

	// A subsequent verified result should NOT downgrade an
	// existing mismatch.  Sibling terminal states are first-wins
	// to prevent UI flicker and protect the user from a stale
	// RPC re-resolve overwriting a real mismatch.  Both the
	// phase AND the mismatchField stay intact.
	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'verified' }
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.phase, 'paid_mismatch', 'first wins (mismatch holds)');
	assertEqual(entry?.mismatchField, 'memo', 'field preserved with phase');
});

scenario('recordVerificationPure: verified is sticky against later mismatch', () => {
	let m = recordFundsSentPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 1700,
		direction: 'outgoing'
	});
	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'verified' }
	});
	// A subsequent stale RPC error or re-render shouldn't
	// downgrade.
	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'rpc_error', message: 'late' }
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.phase, 'paid_verified', 'sticky verified');
});

scenario('recordVerificationPure: defensive entry creation', () => {
	// Verification result for a permlink we haven't seen — record
	// minimally rather than dropping.
	const m = recordVerificationPure(empty, {
		orderPermlink: 'ord-orphan',
		verifyResult: { kind: 'verified' }
	});
	assertTrue(m.get('ord-orphan') !== undefined, 'created');
	assertEqual(m.get('ord-orphan')?.phase, 'paid_verified', 'phase');
});

// ─── End-to-end happy path ────────────────────────────────────────

scenario('e2e happy path: address → paid → verified', () => {
	let m: ReadonlyMap<string, TradeState> = empty;
	m = recordAddressSharedPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedAmount: 1700,
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	assertEqual(m.get('ord-1')?.phase, 'address_shared', 'p1');

	m = recordFundsSentPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		claimedMemo: 'abc12345',
		amount: 1700,
		direction: 'outgoing'
	});
	assertEqual(m.get('ord-1')?.phase, 'paid', 'p2');
	assertEqual(m.get('ord-1')?.verifyResult, 'pending', 'pending');

	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'verified' }
	});
	assertEqual(m.get('ord-1')?.phase, 'paid_verified', 'p3');
});

scenario('e2e mismatch path: address → paid → mismatch', () => {
	let m: ReadonlyMap<string, TradeState> = empty;
	m = recordAddressSharedPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	m = recordFundsSentPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		claimedMemo: 'fake0000',
		amount: 1700,
		direction: 'outgoing'
	});
	m = recordVerificationPure(m, {
		orderPermlink: 'ord-1',
		verifyResult: { kind: 'mismatch', field: 'memo' }
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.phase, 'paid_mismatch', 'phase');
	assertEqual(entry?.mismatchField, 'memo', 'field');
});

// ─── F-40 lock-on-engagement semantics ────────────────────────────

scenario('F-40: outgoing locks engagedPeer', () => {
	const m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	assertEqual(m.get('ord-1')?.engagedPeer, 'bob', 'engaged');
});

scenario('F-40: incoming on a tentative (no-engagement) entry succeeds', () => {
	const m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'mallory',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'poison01',
		direction: 'incoming'
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.peer, 'mallory', 'peer set');
	assertEqual(entry?.engagedPeer, undefined, 'no engagement');
	assertEqual(entry?.expectedMemo, 'poison01', 'memo set');
});

scenario('F-40: incoming from non-engaged peer is DROPPED after engagement', () => {
	// User engages with Bob (sends address pill OUT to Bob).
	let m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	const beforePoison = m.get('ord-1');

	// Mallory sends a poisoning incoming address-shared.
	m = recordAddressSharedPure(m, {
		orderPermlink: 'ord-1',
		peer: 'mallory',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'poison01',
		direction: 'incoming'
	});

	const afterPoison = m.get('ord-1');
	// Entry unchanged — Mallory's update was dropped.
	assertEqual(afterPoison?.peer, 'bob', 'peer preserved');
	assertEqual(afterPoison?.expectedMemo, 'abc12345', 'memo preserved');
	assertEqual(afterPoison?.updatedAt, beforePoison?.updatedAt, 'updatedAt unchanged');
});

scenario('F-40: incoming from engaged peer is APPLIED after engagement', () => {
	let m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	// Bob's reply (incoming funds-sent) — should apply, advance phase.
	m = recordFundsSentPure(m, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		claimedMemo: 'abc12345',
		amount: 1700,
		direction: 'incoming'
	});
	const entry = m.get('ord-1');
	assertEqual(entry?.phase, 'paid', 'advanced to paid');
	assertEqual(entry?.engagedPeer, 'bob', 'engagement preserved');
	assertEqual(entry?.expectedMemo, 'abc12345', 'memo from outgoing preserved');
});

scenario(
	'F-40: incoming poison BEFORE engagement, then outgoing engagement → still drops subsequent poison',
	() => {
		// Mallory poisons a tentative entry first.
		let m = recordAddressSharedPure(empty, {
			orderPermlink: 'ord-1',
			peer: 'mallory',
			method: 'blurt',
			address: 'alice',
			expectedMemo: 'poison01',
			direction: 'incoming'
		});
		// User engages with Bob (sends OUT to Bob).
		// This OVERWRITES the tentative entry — peer/memo/etc. get
		// updated to bob's values, and engagedPeer is set to bob.
		m = recordAddressSharedPure(m, {
			orderPermlink: 'ord-1',
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			expectedMemo: 'abc12345',
			direction: 'outgoing'
		});
		let entry = m.get('ord-1');
		assertEqual(entry?.engagedPeer, 'bob', 'engaged with bob');
		assertEqual(entry?.expectedMemo, 'abc12345', 'memo replaced by outgoing');
		assertEqual(entry?.peer, 'bob', 'peer replaced');

		// Mallory tries again post-engagement — dropped.
		m = recordAddressSharedPure(m, {
			orderPermlink: 'ord-1',
			peer: 'mallory',
			method: 'blurt',
			address: 'alice',
			expectedMemo: 'poison02',
			direction: 'incoming'
		});
		entry = m.get('ord-1');
		assertEqual(entry?.expectedMemo, 'abc12345', 'still bob memo');
		assertEqual(entry?.peer, 'bob', 'peer still bob');
	}
);

scenario('F-40: engagement is sticky — outgoing to different peer does NOT re-engage', () => {
	// User somehow sends an outgoing payload to Charlie referencing
	// the same orderPermlink that's already engaged with Bob (UI bug
	// or buggy code path).  Engagement should not flip; the entry
	// stays locked to Bob.  This is defense-in-depth behavior — UI
	// should prevent reaching this state, but the mutator guards.
	let m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		direction: 'outgoing'
	});
	m = recordAddressSharedPure(m, {
		orderPermlink: 'ord-1',
		peer: 'charlie',
		method: 'blurt',
		address: 'alice',
		direction: 'outgoing'
	});
	const entry = m.get('ord-1');
	// Outgoing always APPLIES — entry's peer reflects the latest
	// outgoing send.  But engagedPeer stays at the FIRST engaged
	// peer (bob) per `existing?.engagedPeer ?? args.peer`.
	assertEqual(entry?.peer, 'charlie', 'peer reflects latest outgoing');
	assertEqual(entry?.engagedPeer, 'bob', 'engagement sticky to first');
});

scenario('F-40: incoming funds_sent from non-engaged peer dropped', () => {
	let m = recordAddressSharedPure(empty, {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'blurt',
		address: 'alice',
		expectedMemo: 'abc12345',
		direction: 'outgoing'
	});
	const before = m.get('ord-1');
	m = recordFundsSentPure(m, {
		orderPermlink: 'ord-1',
		peer: 'mallory',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 1700,
		direction: 'incoming'
	});
	const after = m.get('ord-1');
	// Mallory's funds-sent dropped — phase still address_shared.
	assertEqual(after?.phase, 'address_shared', 'phase unchanged');
	assertEqual(after?.peer, 'bob', 'peer unchanged');
	assertEqual(after?.txid, undefined, 'no txid added');
	assertEqual(after?.updatedAt, before?.updatedAt, 'updatedAt unchanged');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
