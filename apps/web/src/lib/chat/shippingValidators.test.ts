/**
 * The shipment and mailing-address forms can ask the payload module the
 * encoder's own question before sending, and get a code to translate —
 * instead of the encoder throwing a developer-English message the form then
 * shows verbatim (a note pasted with a TAB, a street of spaces).
 */
import { describe, expect, it } from 'vitest';
import * as payload from './payload';
import type { MailingAddressPayload, ShipmentPayload } from './payload';

const address = (over: Partial<MailingAddressPayload>): MailingAddressPayload => ({
	v: 1,
	kind: 'morphit_mailing_address',
	country: 'DE',
	street: 'Hauptstr. 1',
	city: 'Berlin',
	postalCode: '10115',
	...over
});
const shipment = (over: Partial<ShipmentPayload>): ShipmentPayload => ({
	v: 1,
	kind: 'morphit_shipment',
	carrier: 'dhl',
	tracking: '00340434161094042557',
	...over
});

/** What the encoder says about `p`: null when it encodes, else its code. */
function encoderVerdict(encode: () => string): string | null {
	try {
		encode();
		return null;
	} catch (err) {
		return err instanceof payload.PayloadValidationError ? err.problem : `untyped: ${String(err)}`;
	}
}

describe('mailing address', () => {
	it.each([
		['a note with a TAB', address({ note: 'ring\tbell' }), 'note_forbidden_chars'],
		[
			'a street of spaces, trimmed as the form sends it',
			address({ street: '   '.trim() }),
			'street_required'
		],
		['a lowercase country', address({ country: 'de' }), 'country_invalid'],
		['a long city', address({ city: 'x'.repeat(500) }), 'city_too_long'],
		['a good address', address({ note: 'leave at door' }), null]
	])('%s', (_l, p, code) => {
		expect(payload.mailingAddressProblem(p)).toBe(code);
		expect(encoderVerdict(() => payload.encodeMailingAddressPayload(p))).toBe(code);
	});
});

describe('shipment', () => {
	it.each([
		['a note with a TAB', shipment({ note: 'fragile\tglass' }), 'note_forbidden_chars'],
		[
			'an http tracking link',
			shipment({ carrier: 'other', customTrackingUrl: 'http://x.example/t' }),
			'custom_tracking_url_invalid'
		],
		['an empty tracking number', shipment({ tracking: '' }), 'tracking_invalid'],
		['a good shipment', shipment({}), null]
	])('%s', (_l, p, code) => {
		expect(payload.shipmentProblem(p)).toBe(code);
		expect(encoderVerdict(() => payload.encodeShipmentPayload(p))).toBe(code);
	});
});
