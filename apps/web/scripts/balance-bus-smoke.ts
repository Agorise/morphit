#!/usr/bin/env tsx
/**
 * balance-bus-smoke
 *
 * Verifies the balance refresh bus correctness:
 *   1. subscribe → trigger → handler runs once
 *   2. unsubscribe stops further triggers from firing the handler
 *   3. multiple subscribers all run on a single trigger
 *   4. a throwing handler does not break the bus for siblings
 *   5. _resetBalanceRefreshBus drains the set
 *
 * The bus is a tiny pub-sub primitive that powers near-real-time
 * balance updates.  This smoke exists to keep the contract tight
 * — the balance card depends on it for snappy updates after fee
 * payments and BLURT receipt verifications.
 */

import {
	subscribeBalanceRefresh,
	triggerBalanceRefresh,
	_resetBalanceRefreshBus
} from '../src/lib/balance/bus.ts';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.log(`  ✗ ${label}`);
	}
}

// ─── 1: subscribe → trigger → handler runs ─────────────────────
{
	_resetBalanceRefreshBus();
	let n = 0;
	const off = subscribeBalanceRefresh(() => {
		n++;
	});
	triggerBalanceRefresh();
	check('1: handler called once after one trigger', n === 1);
	off();
}

// ─── 2: unsubscribe stops handler ──────────────────────────────
{
	_resetBalanceRefreshBus();
	let n = 0;
	const off = subscribeBalanceRefresh(() => {
		n++;
	});
	off();
	triggerBalanceRefresh();
	check('2: handler not called after unsubscribe', n === 0);
}

// ─── 3: multiple subscribers all fire ──────────────────────────
{
	_resetBalanceRefreshBus();
	const calls: string[] = [];
	const off1 = subscribeBalanceRefresh(() => calls.push('a'));
	const off2 = subscribeBalanceRefresh(() => calls.push('b'));
	const off3 = subscribeBalanceRefresh(() => calls.push('c'));
	triggerBalanceRefresh();
	check(
		'3: all three subscribers ran',
		calls.length === 3 && calls.includes('a') && calls.includes('b') && calls.includes('c')
	);
	off1();
	off2();
	off3();
}

// ─── 4: throwing handler doesn't break siblings ────────────────
{
	_resetBalanceRefreshBus();
	let bRan = false;
	const off1 = subscribeBalanceRefresh(() => {
		throw new Error('intentional');
	});
	const off2 = subscribeBalanceRefresh(() => {
		bRan = true;
	});
	let threw = false;
	try {
		triggerBalanceRefresh();
	} catch {
		threw = true;
	}
	check('4a: trigger absorbed the handler error', !threw);
	check('4b: sibling handler still ran', bRan);
	off1();
	off2();
}

// ─── 5: _reset drains all subscribers ──────────────────────────
{
	let n = 0;
	subscribeBalanceRefresh(() => {
		n++;
	});
	subscribeBalanceRefresh(() => {
		n++;
	});
	_resetBalanceRefreshBus();
	triggerBalanceRefresh();
	check('5: _reset drained all subscribers', n === 0);
}

// ─── 6: multiple triggers fire handler once each ───────────────
{
	_resetBalanceRefreshBus();
	let n = 0;
	const off = subscribeBalanceRefresh(() => {
		n++;
	});
	triggerBalanceRefresh();
	triggerBalanceRefresh();
	triggerBalanceRefresh();
	check('6: three triggers ran handler three times', n === 3);
	off();
}

// ─── 7: handler can unsubscribe itself during fire ─────────────
//     Documenting current behavior: this is undefined-safe per
//     Set semantics (no exception, but the next fire won't re-call).
{
	_resetBalanceRefreshBus();
	let n = 0;
	let off: (() => void) | null = null;
	off = subscribeBalanceRefresh(() => {
		n++;
		if (off !== null) off();
	});
	triggerBalanceRefresh();
	triggerBalanceRefresh(); // should not re-fire after self-unsubscribe
	check('7: self-unsubscribing handler fires exactly once', n === 1);
}

if (fail === 0) {
	console.log(`\n✓ all ${pass} balance-bus scenarios passed`);
	process.exit(0);
} else {
	console.log(`\n✗ ${fail} of ${pass + fail} scenarios failed`);
	process.exit(1);
}
