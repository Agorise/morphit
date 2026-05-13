#!/usr/bin/env tsx
/**
 * Smoke for the listener's pure dispatch logic.
 *
 * Phase F.5 audit fix (F-32) — exercises planListenerDispatch
 * without needing to mock the listener's I/O.  Synthetic decoded
 * payloads + contexts; assertions on the resulting plan shape.
 */

import {
	planListenerDispatch,
	type ListenerDispatchPlan
} from '../../web/src/lib/trades/listenerDispatch.ts';
import type { DecodeResult } from '../../web/src/lib/chat/payload.ts';

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

function assertNull(value: unknown, label: string): void {
	if (value !== null) throw new Error(`${label}: expected null, got ${JSON.stringify(value)}`);
}

function assertNotNull<T>(value: T | null, label: string): asserts value is T {
	if (value === null) throw new Error(`${label}: expected non-null`);
}

const baseCtx = {
	sender: 'bob',
	me: 'alice',
	currentPathname: '/my/orders'
};

const baseAddress: DecodeResult = {
	kind: 'address',
	payload: {
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		amount: '0.005',
		orderPermlink: 'order-abc'
	}
};

const baseFundsSentBlurt: DecodeResult = {
	kind: 'funds_sent',
	payload: {
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: '1700.000',
		memo: 'abc12345',
		orderPermlink: 'order-abc'
	}
};

console.log('\n── F-32 listener-dispatch smoke ─────────────────────────\n');

// ─── Empty plan paths ─────────────────────────────────────────────

scenario('plaintext payload → empty plan', () => {
	const plan = planListenerDispatch({ kind: 'plaintext' }, baseCtx);
	assertNull(plan.store, 'store');
	assertNull(plan.verify, 'verify');
	assertNull(plan.notify, 'notify');
});

scenario('unknown_version → empty plan', () => {
	const plan = planListenerDispatch({ kind: 'unknown_version', version: 99 }, baseCtx);
	assertNull(plan.store, 'store');
	assertNull(plan.verify, 'verify');
	assertNull(plan.notify, 'notify');
});

scenario('unknown_kind → empty plan', () => {
	const plan = planListenerDispatch({ kind: 'unknown_kind', name: 'morphit_dispute' }, baseCtx);
	assertNull(plan.store, 'store');
	assertNull(plan.verify, 'verify');
	assertNull(plan.notify, 'notify');
});

scenario('structured payload without orderPermlink → empty plan', () => {
	const decoded: DecodeResult = {
		kind: 'address',
		payload: {
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
			// no orderPermlink
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNull(plan.store, 'store');
	assertNull(plan.verify, 'verify');
	assertNull(plan.notify, 'notify');
});

// ─── Store effect ─────────────────────────────────────────────────

scenario('address payload → recordAddressShared store effect', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.store, 'store');
	assertEqual(plan.store.kind, 'recordAddressShared', 'kind');
	if (plan.store.kind === 'recordAddressShared') {
		assertEqual(plan.store.args.peer, 'bob', 'peer');
		assertEqual(plan.store.args.direction, 'incoming', 'direction');
		assertEqual(plan.store.args.method, 'btc', 'method');
		assertEqual(plan.store.args.expectedAmount, 0.005, 'amount');
	}
});

scenario('funds_sent payload → recordFundsSent store effect', () => {
	const plan = planListenerDispatch(baseFundsSentBlurt, baseCtx);
	assertNotNull(plan.store, 'store');
	assertEqual(plan.store.kind, 'recordFundsSent', 'kind');
	if (plan.store.kind === 'recordFundsSent') {
		assertEqual(plan.store.args.peer, 'bob', 'peer');
		assertEqual(plan.store.args.direction, 'incoming', 'direction');
		assertEqual(plan.store.args.amount, 1700, 'amount');
		assertEqual(plan.store.args.txid, 'a'.repeat(40), 'txid');
	}
});

// ─── Verify effect (F-41) ─────────────────────────────────────────

scenario('BLURT funds_sent → verify effect populated', () => {
	const plan = planListenerDispatch(baseFundsSentBlurt, baseCtx);
	assertNotNull(plan.verify, 'verify');
	assertEqual(plan.verify.recipient, 'alice', 'recipient = me');
	assertEqual(plan.verify.sender, 'bob', 'sender');
	assertEqual(plan.verify.amountBlurt, 1700, 'amount');
	assertEqual(plan.verify.echoedMemo, 'abc12345', 'echoedMemo');
});

scenario('BTC funds_sent → no verify effect (BLURT-only)', () => {
	const decoded: DecodeResult = {
		kind: 'funds_sent',
		payload: {
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'btc',
			txid: 'a'.repeat(64),
			amount: '0.005',
			orderPermlink: 'order-abc'
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNotNull(plan.store, 'store');
	assertNull(plan.verify, 'verify (no BTC chain verifier)');
});

scenario('address payload → no verify effect (only funds_sent verifies)', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.store, 'store');
	assertNull(plan.verify, 'no verify');
});

scenario('BLURT funds_sent without amount → no verify effect', () => {
	const decoded: DecodeResult = {
		kind: 'funds_sent',
		payload: {
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'a'.repeat(40),
			orderPermlink: 'order-abc'
			// no amount
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNull(plan.verify, 'no verify');
});

// ─── Notify effect ────────────────────────────────────────────────

scenario('address on /my/orders → notify effect populated', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.kind, 'address', 'kind');
	assertEqual(plan.notify.toastKind, 'info', 'toast kind');
	assertEqual(plan.notify.i18n.titleKey, 'chat.trade_event.address_shared_title', 'titleKey');
});

scenario('funds_sent with amount → funds_sent_body_with_amount key', () => {
	const plan = planListenerDispatch(baseFundsSentBlurt, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.i18n.bodyKey, 'chat.trade_event.funds_sent_body_with_amount', 'bodyKey');
	assertEqual(plan.notify.toastKind, 'success', 'toast kind');
});

scenario('funds_sent without amount → funds_sent_body key', () => {
	const decoded: DecodeResult = {
		kind: 'funds_sent',
		payload: {
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'btc',
			txid: 'a'.repeat(64),
			orderPermlink: 'order-abc'
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.i18n.bodyKey, 'chat.trade_event.funds_sent_body', 'bodyKey');
});

// ─── F-38: same-page suppression ──────────────────────────────────

scenario('F-38: on /chat/<sender> exact path → notify suppressed', () => {
	const plan = planListenerDispatch(baseAddress, {
		...baseCtx,
		currentPathname: '/chat/bob'
	});
	assertNotNull(plan.store, 'store still applied');
	assertNull(plan.notify, 'notify suppressed');
});

scenario('F-38: on /chat/<sender>/sub-route → notify suppressed', () => {
	const plan = planListenerDispatch(baseAddress, {
		...baseCtx,
		currentPathname: '/chat/bob/something'
	});
	assertNull(plan.notify, 'notify suppressed (sub-route)');
});

scenario('F-38: on /chat/<other> → notify NOT suppressed', () => {
	const plan = planListenerDispatch(baseAddress, {
		...baseCtx,
		currentPathname: '/chat/charlie'
	});
	assertNotNull(plan.notify, 'notify fires for other peer');
});

scenario('F-38: on /chatBOB (lookalike, not the chat path) → notify NOT suppressed', () => {
	// Defense against careless prefix matching: /chatBOB shouldn't
	// match /chat/bob
	const plan = planListenerDispatch(baseAddress, {
		...baseCtx,
		currentPathname: '/chatBOB'
	});
	assertNotNull(plan.notify, 'notify fires (different path)');
});

// ─── F-28: long permlink truncation ───────────────────────────────

scenario('F-28: long permlink truncated in display values', () => {
	const longPermlink = 'morphit-order-2026-04-27-very-long-suffix-blah';
	const decoded: DecodeResult = {
		kind: 'address',
		payload: {
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			orderPermlink: longPermlink
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNotNull(plan.notify, 'notify');
	const display = plan.notify.i18n.values.orderPermlink;
	if (display.length > 22) throw new Error(`display still ${display.length} chars: ${display}`);
	if (!display.endsWith('…')) throw new Error(`expected ellipsis, got ${display}`);
	// href uses full permlink unchanged
	if (!plan.notify.href.includes(encodeURIComponent(longPermlink)))
		throw new Error('href should contain full permlink');
});

scenario('F-28: short permlink unchanged', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.i18n.values.orderPermlink, 'order-abc', 'unchanged');
});

// ─── F-31: notification tag includes permlink ─────────────────────

scenario('F-31: notification tag includes orderPermlink', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.notificationTag, 'morphit-trade-order-abc', 'tag scoped to permlink');
});

// ─── deep-link encoding ───────────────────────────────────────────

scenario('href encodes peer and orderPermlink', () => {
	const decoded: DecodeResult = {
		kind: 'address',
		payload: {
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			orderPermlink: 'order with spaces' // shouldn't really happen but tests encoding
		}
	};
	const plan = planListenerDispatch(decoded, {
		...baseCtx,
		sender: 'bob.test'
	});
	assertNotNull(plan.notify, 'notify');
	if (!plan.notify.href.includes('bob.test')) throw new Error('peer in href');
	if (!plan.notify.href.includes('order%20with%20spaces'))
		throw new Error('encoded permlink in href');
});

// ─── Method values ────────────────────────────────────────────────

scenario('method uppercased in i18n values', () => {
	const plan = planListenerDispatch(baseAddress, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.i18n.values.method, 'BTC', 'uppercase');
});

scenario('XMR method uppercased', () => {
	const decoded: DecodeResult = {
		kind: 'address',
		payload: {
			v: 1,
			kind: 'morphit_addr',
			method: 'xmr',
			address:
				'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o',
			orderPermlink: 'order-abc'
		}
	};
	const plan = planListenerDispatch(decoded, baseCtx);
	assertNotNull(plan.notify, 'notify');
	assertEqual(plan.notify.i18n.values.method, 'XMR', 'uppercase');
});

// ─── Empty pathname (non-browser context) ─────────────────────────

scenario('empty pathname (server-side) → notify still fires', () => {
	// In a non-browser context (SSR), currentPathname is empty
	// string.  That should NOT match any /chat/... path; notify
	// fires.  Though in practice the listener doesn't run during
	// SSR, this guards the contract.
	const plan = planListenerDispatch(baseAddress, {
		...baseCtx,
		currentPathname: ''
	});
	assertNotNull(plan.notify, 'notify fires when no path');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
