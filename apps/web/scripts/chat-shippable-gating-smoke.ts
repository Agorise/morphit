#!/usr/bin/env tsx
/**
 * chat-shippable-gating-smoke (cp406).
 *
 * Two things this locks, both easy to get subtly wrong:
 *
 * 1. WHICH payment methods are "shippable" — i.e. move a physical thing that
 *    can be posted, so a trade using them unlocks the in-chat "Share mailing
 *    address" + "Record shipment" controls. Per Ken: barter goods, precious
 *    metals (handed over in person OR shipped) and cash-by-mail (the cash
 *    envelope is posted). Cash-in-person is physical but face-to-face only →
 *    NOT shippable. Everything electronic/on-chain is not physical at all.
 *
 * 2. The ship/mail DIRECTION invariant. The physical item IS the payment for
 *    the crypto, so whoever RECEIVES the crypto is the one paying physically →
 *    they SHIP it ("Record shipment"); whoever SENDS the crypto is receiving
 *    that physical payment → they say where to send it ("Share mailing
 *    address"). Getting this backwards shows grandma the wrong button. The
 *    helper below mirrors ConversationView's two deriveds exactly
 *    (showRecordShipmentButton = orderCanShip && showShareAddressButton;
 *     showShareMailingButton   = orderCanShip && showPayNowButton).
 *
 * Usage:
 *   cd apps/web && npx tsx --tsconfig ../../tsconfig.smoke.json scripts/chat-shippable-gating-smoke.ts
 */

import { orderUsesShippableMethod } from '../src/lib/payments/registry.ts';

let failures = 0;
let count = 0;
function check(name: string, cond: boolean, detail = ''): void {
	count++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// Mirror of ConversationView's gating (the crypto-direction booleans feed in).
function chatShippingButtons(
	paymentMethods: readonly string[],
	iAmCryptoReceiver: boolean
): { showRecordShipment: boolean; showShareMailing: boolean } {
	const canShip = orderUsesShippableMethod(paymentMethods);
	return {
		showRecordShipment: canShip && iAmCryptoReceiver, // I receive crypto → I pay physically → I ship
		showShareMailing: canShip && !iAmCryptoReceiver // I send crypto → I receive the physical payment
	};
}

// ── 1. shippable set ──
check('1 — barter_goods is shippable', orderUsesShippableMethod(['barter_goods']));
check('2 — precious_metals is shippable', orderUsesShippableMethod(['precious_metals']));
check('3 — cash_by_mail is shippable', orderUsesShippableMethod(['cash_by_mail']));
check('4 — cash_in_person is NOT shippable', !orderUsesShippableMethod(['cash_in_person']));
check('5 — a crypto rail (pay_xmr) is NOT shippable', !orderUsesShippableMethod(['pay_xmr']));
check('6 — an online method (paypal) is NOT shippable', !orderUsesShippableMethod(['paypal']));
check(
	'7 — mixed methods: any shippable ⇒ shippable',
	orderUsesShippableMethod(['cash_in_person', 'barter_goods'])
);
check(
	'8 — mixed non-shippable ⇒ not shippable',
	!orderUsesShippableMethod(['cash_in_person', 'paypal', 'pay_btc'])
);
check('9 — empty methods ⇒ not shippable', !orderUsesShippableMethod([]));
check('10 — unknown key ignored ⇒ not shippable', !orderUsesShippableMethod(['not_a_real_method']));

// ── 2. direction invariant — Ken's Kenya-baskets barter ──
// Amara: BUY order for XMR, pays with baskets (barter_goods). She RECEIVES the
// crypto → she ships the baskets.
{
	const amara = chatShippingButtons(['barter_goods'], /* iAmCryptoReceiver */ true);
	check('11 — barter crypto-RECEIVER (Amara) shows Record shipment', amara.showRecordShipment);
	check('12 — barter crypto-RECEIVER (Amara) does NOT show Share mailing', !amara.showShareMailing);
}
// Bob: SELLS the XMR to Amara. He SENDS the crypto → he receives the baskets →
// he shares where to ship them.
{
	const bob = chatShippingButtons(['barter_goods'], /* iAmCryptoReceiver */ false);
	check('13 — barter crypto-SENDER (Bob) shows Share mailing', bob.showShareMailing);
	check('14 — barter crypto-SENDER (Bob) does NOT show Record shipment', !bob.showRecordShipment);
}
// Same invariant for cash-by-mail (crypto buyer mails the cash → ships it).
{
	const buyerMailsCash = chatShippingButtons(['cash_by_mail'], true);
	check('15 — cash-by-mail crypto-RECEIVER ships the cash envelope', buyerMailsCash.showRecordShipment);
	const sellerGetsCash = chatShippingButtons(['cash_by_mail'], false);
	check('16 — cash-by-mail crypto-SENDER shares where to mail the cash', sellerGetsCash.showShareMailing);
}
// Cash-in-person: neither control, either side (Ken's kentest3 scenario).
{
	const buyer = chatShippingButtons(['cash_in_person'], true);
	const seller = chatShippingButtons(['cash_in_person'], false);
	check(
		'17 — cash-in-person shows neither shipping control (either party)',
		!buyer.showRecordShipment && !buyer.showShareMailing && !seller.showRecordShipment && !seller.showShareMailing
	);
}

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-shippable-gating-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} chat-shippable-gating scenarios passed`);
