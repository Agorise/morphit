/**
 * v1.21.14 full chat audit:
 *
 *   W-M5  a structured message the forms accept must fit the indexer's
 *         ciphertext cap, in BOTH envelope formats — a mailing address with
 *         every field filled was broadcast, the fee charged, and then refused
 *         by the indexer ("on chain, not accepted");
 *   W-L9  the mailing address's and the shipment's text fields refuse control
 *         and direction-override characters (only the notes did), on encode
 *         and on decode.
 *
 * Real crypto: the budget is checked against what the envelopes really make.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	MAILING_ADDRESS_LIMITS as L,
	MAX_CHAT_CIPHERTEXT_CHARS,
	PayloadValidationError,
	SHIPMENT_LIMITS as S,
	chatCiphertextChars,
	decodePayload,
	encodeMailingAddressPayload,
	fitsChatMessage,
	mailingAddressProblem,
	shipmentProblem,
	type MailingAddressPayload,
	type ShipmentPayload
} from './payload';
import {
	deriveChatIdentity,
	encryptToPostingKey,
	encryptToRecipient,
	postingPubOf
} from './crypto';

const INDEXER_CHAT = fileURLToPath(
	new URL('../../../../indexer/src/indexer/handlers/chat.ts', import.meta.url)
);

async function sealBoth(plaintext: string) {
	const a = await deriveChatIdentity(new Uint8Array(32).fill(1), 'alice');
	const b = await deriveChatIdentity(new Uint8Array(32).fill(2), 'bob');
	const v2 = await encryptToRecipient(plaintext, b.pub, a, 'alice', 'bob', true);
	const v3 = await encryptToPostingKey(
		plaintext,
		[postingPubOf(new Uint8Array(32).fill(3))],
		new Uint8Array(32).fill(4),
		'alice',
		'bob',
		true
	);
	return { v2, v3 };
}

describe('W-M5: the budget is the indexer’s, and exact for both formats', () => {
	it('the cap is the indexer’s own constant', () => {
		const src = readFileSync(INDEXER_CHAT, 'utf8');
		const m = /const MAX_CIPHERTEXT_CHARS = (\d+);/.exec(src);
		expect(m).not.toBeNull();
		expect(MAX_CHAT_CIPHERTEXT_CHARS).toBe(Number(m![1]));
	});

	it('the predicted length is what v2 (with its self-copy) and v3 really produce', async () => {
		for (const text of [
			'',
			'hi',
			'ü'.repeat(100),
			'请'.repeat(333),
			'😀'.repeat(57),
			'x'.repeat(1136)
		]) {
			const { v2, v3 } = await sealBoth(text);
			expect(v2.ciphertext.length).toBe(chatCiphertextChars(text));
			expect(v2.selfCiphertext!.length).toBe(chatCiphertextChars(text));
			expect(v3.ciphertext.length).toBe(chatCiphertextChars(text));
		}
	});

	it('1136 UTF-8 bytes fit, 1137 do not — exactly at the indexer’s line, in both formats', async () => {
		const fits = 'x'.repeat(1136);
		const over = 'x'.repeat(1137);
		expect(fitsChatMessage(fits)).toBe(true);
		expect(fitsChatMessage(over)).toBe(false);
		const a = await sealBoth(fits);
		const b = await sealBoth(over);
		expect(a.v2.ciphertext.length).toBeLessThanOrEqual(MAX_CHAT_CIPHERTEXT_CHARS);
		expect(a.v3.ciphertext.length).toBeLessThanOrEqual(MAX_CHAT_CIPHERTEXT_CHARS);
		expect(b.v2.ciphertext.length).toBeGreaterThan(MAX_CHAT_CIPHERTEXT_CHARS);
		expect(b.v3.ciphertext.length).toBeGreaterThan(MAX_CHAT_CIPHERTEXT_CHARS);
	});

	const fullAddress: MailingAddressPayload = {
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'MX',
		street: 'a'.repeat(L.streetMax),
		street2: 'b'.repeat(L.streetMax),
		city: 'c'.repeat(L.cityMax),
		state: 'd'.repeat(L.stateMax),
		postalCode: '1'.repeat(L.postalCodeMax),
		recipientName: 'e'.repeat(L.recipientNameMax),
		note: 'f'.repeat(L.noteMax),
		orderPermlink: 'sell-btc-' + 'x'.repeat(60)
	};

	it('a mailing address with every field at its limit: refused BEFORE sending, and the encoder agrees', () => {
		expect(mailingAddressProblem(fullAddress)).toBe('too_long_to_send');
		expect(() => encodeMailingAddressPayload(fullAddress)).toThrow(PayloadValidationError);
	});

	it('a Chinese address with a 400-character note: refused too', () => {
		expect(
			mailingAddressProblem({
				v: 1,
				kind: 'morphit_mailing_address',
				country: 'CN',
				street: '北'.repeat(60),
				city: '上'.repeat(10),
				postalCode: '200000',
				recipientName: '王'.repeat(4),
				note: '请'.repeat(400)
			})
		).toBe('too_long_to_send');
	});

	it('an ordinary address is fine', () => {
		const ok: MailingAddressPayload = {
			v: 1,
			kind: 'morphit_mailing_address',
			country: 'DE',
			street: 'Hauptstraße 5',
			city: 'Berlin',
			postalCode: '10115',
			note: 'Klingeln bei Müller'
		};
		expect(mailingAddressProblem(ok)).toBeNull();
		expect(fitsChatMessage(encodeMailingAddressPayload(ok))).toBe(true);
	});

	it('a shipment with a long multi-byte note and link: refused before sending', () => {
		const p: ShipmentPayload = {
			v: 1,
			kind: 'morphit_shipment',
			carrier: 'other',
			tracking: 'AB123456789CN',
			customCarrierName: '顺'.repeat(S.customCarrierNameMax),
			customTrackingUrl: 'https://track.example/' + 'x'.repeat(400),
			note: '请'.repeat(S.noteMax)
		};
		expect(shipmentProblem(p)).toBe('too_long_to_send');
		expect(shipmentProblem({ ...p, note: 'short', customCarrierName: 'Shunfeng' })).toBeNull();
	});
});

describe('W-L9: no direction overrides in the text a reader sees', () => {
	const RLO = '‮';
	const base: MailingAddressPayload = {
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'MX',
		street: 'Av. Juárez 10',
		street2: 'Depto 4',
		city: 'Ciudad Ejemplo',
		state: 'Estado Ejemplo',
		postalCode: '82000',
		recipientName: 'Ana'
	};
	const wire = (p: MailingAddressPayload) =>
		JSON.stringify({
			v: 1,
			kind: 'morphit_mailing_address',
			country: p.country,
			street: p.street,
			street2: p.street2,
			city: p.city,
			state: p.state,
			postal_code: p.postalCode,
			recipient_name: p.recipientName
		});

	for (const field of [
		'street',
		'street2',
		'city',
		'state',
		'postalCode',
		'recipientName'
	] as const) {
		it(`${field}: refused when sending, and a received one is not shown as an address`, () => {
			const bad = { ...base, [field]: `x${RLO}y` };
			expect(mailingAddressProblem(bad)).toBe('field_forbidden_chars');
			expect(decodePayload(wire(bad)).kind).toBe('plaintext');
			// A line break is refused the same way.
			expect(mailingAddressProblem({ ...base, [field]: 'x\ny' })).toBe('field_forbidden_chars');
		});
	}

	it('the untouched address decodes', () => {
		expect(decodePayload(wire(base)).kind).toBe('mailing_address');
	});

	it('the carrier name and the tracking link of a shipment', () => {
		const ship: ShipmentPayload = {
			v: 1,
			kind: 'morphit_shipment',
			carrier: 'other',
			tracking: 'AB123456789CN',
			customCarrierName: 'Estafeta',
			customTrackingUrl: 'https://track.example/AB123'
		};
		const shipWire = (p: ShipmentPayload) =>
			JSON.stringify({
				v: 1,
				kind: 'morphit_shipment',
				carrier: p.carrier,
				tracking: p.tracking,
				custom_carrier_name: p.customCarrierName,
				custom_tracking_url: p.customTrackingUrl
			});
		expect(shipmentProblem(ship)).toBeNull();
		expect(decodePayload(shipWire(ship)).kind).toBe('shipment');
		const badName = { ...ship, customCarrierName: `Esta${RLO}feta` };
		expect(shipmentProblem(badName)).toBe('field_forbidden_chars');
		expect(decodePayload(shipWire(badName)).kind).toBe('plaintext');
		const badUrl = { ...ship, customTrackingUrl: `https://track.example/${RLO}x` };
		expect(shipmentProblem(badUrl)).toBe('custom_tracking_url_invalid');
		expect(decodePayload(shipWire(badUrl)).kind).toBe('plaintext');
	});
});
