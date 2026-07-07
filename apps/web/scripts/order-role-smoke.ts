/**
 * Order-role money-flow smoke (cp406).
 *
 * Pure-function coverage of peerCryptoSide() — the helper that decides,
 * for a chat about an order, whether the PEER is buying or selling the
 * asset. That single value gates the two money-flow buttons in
 * ConversationView: peer BUYS ⇒ I send crypto ⇒ "Pay now"; peer SELLS ⇒
 * I receive crypto ⇒ "Share address". Getting it wrong shows the wrong
 * party the wrong action, so it is regression-locked here.
 *
 * The subtlety this guards (cp406): the chat may be about the peer's
 * order OR our own (the peer opened the chat about it). An order's raw
 * `side` is ALWAYS the poster's perspective, so when the order is ours
 * the peer's side is the OPPOSITE. Ken's canonical scenario — kentest3
 * posts a BUY order, kentest2 is the seller — is asserted from both
 * sides.
 *
 * Usage:
 *   tsx apps/web/scripts/order-role-smoke.ts
 */

import { peerCryptoSide, chatMoneyFlow } from '../src/lib/chat/orderRole.ts';

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

function assertEqual(actual: string, expected: string, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
}

console.log('order-role-smoke: peerCryptoSide money-flow direction');

// ── Peer owns the order → owner side IS the peer side (as-is) ─────────
scenario("peer's BUY order → peer buys the asset", () => {
	assertEqual(peerCryptoSide('buy', false), 'buy', "peer buy");
});
scenario("peer's SELL order → peer sells the asset", () => {
	assertEqual(peerCryptoSide('sell', false), 'sell', "peer sell");
});

// ── We own the order → peer takes the OPPOSITE side ──────────────────
scenario('my BUY order → peer SELLS to me (I receive crypto ⇒ Share address)', () => {
	assertEqual(peerCryptoSide('buy', true), 'sell', 'my buy → peer sell');
});
scenario('my SELL order → peer BUYS from me (I send crypto ⇒ Pay now)', () => {
	assertEqual(peerCryptoSide('sell', true), 'buy', 'my sell → peer buy');
});

// ── Normalization: anything ≠ 'sell' is treated as 'buy' (orderTitle.ts) ─
scenario("unknown side on peer's order normalizes to 'buy'", () => {
	assertEqual(peerCryptoSide('', false), 'buy', 'empty peer');
	assertEqual(peerCryptoSide('barter', false), 'buy', 'garbage peer');
	assertEqual(peerCryptoSide('BUY', false), 'buy', 'wrong-case peer (≠ "sell")');
});
scenario("unknown side on my order normalizes to 'buy' then flips to 'sell'", () => {
	assertEqual(peerCryptoSide('', true), 'sell', 'empty mine');
	assertEqual(peerCryptoSide('whatever', true), 'sell', 'garbage mine');
});

// ── Ken's canonical scenario, asserted from BOTH sides ───────────────
// kentest3 posts a BUY order for BLURT; kentest2 is the crypto-seller.
scenario('kentest3 (order owner, buying) sees peer=SELL → Share address', () => {
	// From kentest3's ConversationView: order is MINE, side 'buy'.
	assertEqual(peerCryptoSide('buy', /* orderIsMine */ true), 'sell', 'kentest3 view');
});
scenario('kentest2 (peer, selling) sees peer=BUY → Pay now (locked to BLURT)', () => {
	// From kentest2's ConversationView: order is the PEER's (kentest3's),
	// side 'buy', so peer buys ⇒ kentest2 is the sender ⇒ Pay now shows.
	assertEqual(peerCryptoSide('buy', /* orderIsMine */ false), 'buy', 'kentest2 view');
});

// ── cp406 (Ken) — chatMoneyFlow: NO live order ⇒ BOTH buttons hidden ──
// The reported bug: an unsolicited chat (profile "Message" button) or a chat
// whose order went non-live showed BOTH "Pay now" and "Share address" (the
// old peerOrderSide===null fallback showed them). chatMoneyFlow(null,…) must
// hide both.
function assertBool(actual: boolean, expected: boolean, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
}
scenario('no live order (null) → neither Pay now nor Share address', () => {
	const m = chatMoneyFlow(null, false);
	assertBool(m.payNow, false, 'null → payNow');
	assertBool(m.shareAddress, false, 'null → shareAddress');
	const mine = chatMoneyFlow(null, true);
	assertBool(mine.payNow, false, 'null (mine) → payNow');
	assertBool(mine.shareAddress, false, 'null (mine) → shareAddress');
});
scenario("peer's BUY order → Pay now only (I send crypto)", () => {
	const m = chatMoneyFlow({ side: 'buy' }, false);
	assertBool(m.payNow, true, 'peer buy → payNow');
	assertBool(m.shareAddress, false, 'peer buy → shareAddress');
});
scenario("peer's SELL order → Share address only (I receive crypto)", () => {
	const m = chatMoneyFlow({ side: 'sell' }, false);
	assertBool(m.payNow, false, 'peer sell → payNow');
	assertBool(m.shareAddress, true, 'peer sell → shareAddress');
});
scenario('my BUY order → Share address only (peer sells to me)', () => {
	const m = chatMoneyFlow({ side: 'buy' }, true);
	assertBool(m.payNow, false, 'my buy → payNow');
	assertBool(m.shareAddress, true, 'my buy → shareAddress');
});
scenario('exactly one button shows for any live order', () => {
	for (const side of ['buy', 'sell', 'barter', '']) {
		for (const mine of [true, false]) {
			const m = chatMoneyFlow({ side }, mine);
			assertBool(m.payNow !== m.shareAddress, true, `one-of side=${side} mine=${mine}`);
		}
	}
});

console.log(`\norder-role-smoke: ${scenarios - failures}/${scenarios} passed`);
if (failures > 0) {
	console.log(`order-role-smoke: ${failures} FAILED`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} order-role scenarios passed`);
