#!/usr/bin/env tsx
/**
 * apps/web/scripts/shipping-payload-roundtrip-smoke.ts
 *
 * Structural Defense (cp120) — encode-then-decode roundtrip
 * fidelity + validator rejection coverage for the two new
 * chat payload types:
 *
 *   - morphit_mailing_address_v1 (physical mailing address)
 *   - morphit_shipment_v1 (carrier + tracking number)
 *
 * Scenarios (mailing address — M):
 *   M-1: minimum-fields roundtrip (country+street+city+postal_code)
 *   M-2: full-fields roundtrip (all optional fields populated)
 *   M-3: encoder rejects invalid country code
 *   M-4: encoder rejects empty street
 *   M-5: encoder rejects oversize street
 *   M-6: decoder accepts the encoded payload identity
 *   M-7: decoder falls through to plaintext on malformed JSON
 *   M-8: decoder rejects too-short postal code (0 chars)
 *   M-9: decoder rejects oversize note
 *
 * Scenarios (shipment — S):
 *   S-1: USPS canonical-carrier roundtrip
 *   S-2: 'other' carrier with customCarrierName + customTrackingUrl
 *   S-3: encoder rejects unknown-shape carrier key (uppercase)
 *   S-4: encoder rejects too-short tracking (<5 chars)
 *   S-5: encoder rejects too-long tracking (>50 chars)
 *   S-6: encoder rejects non-https customTrackingUrl
 *   S-7: decoder accepts encoded payload identity
 *   S-8: decoder rejects javascript: URL injection attempt
 */

import {
	encodeMailingAddressPayload,
	encodeShipmentPayload,
	decodePayload,
	type MailingAddressPayload,
	type ShipmentPayload
} from '../src/lib/chat/payload';

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── shipping-payload-roundtrip smoke (cp120) ──────\n');

// ─── Mailing address scenarios ─────────────────────────────────

// M-1: minimum-fields roundtrip
{
	const p: MailingAddressPayload = {
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'US',
		street: '123 Main St',
		city: 'Springfield',
		postalCode: '12345'
	};
	try {
		const wire = encodeMailingAddressPayload(p);
		const decoded = decodePayload(wire);
		if (
			decoded.kind === 'mailing_address' &&
			decoded.payload.country === 'US' &&
			decoded.payload.street === '123 Main St' &&
			decoded.payload.city === 'Springfield' &&
			decoded.payload.postalCode === '12345'
		) {
			pass('M-1 minimum-fields roundtrip');
		} else {
			fail('M-1 minimum-fields roundtrip', `decoded: ${JSON.stringify(decoded)}`);
		}
	} catch (e) {
		fail('M-1 minimum-fields roundtrip', `threw: ${e}`);
	}
}

// M-2: full-fields roundtrip
{
	const p: MailingAddressPayload = {
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'DE',
		street: 'Hauptstraße 42',
		street2: 'Hinterhof Aufgang 3',
		city: 'Berlin',
		state: 'Berlin',
		postalCode: '10115',
		recipientName: 'Max Mustermann',
		note: 'Klingel 12 — bitte zweimal klingeln',
		orderPermlink: 'order-abc-123'
	};
	try {
		const wire = encodeMailingAddressPayload(p);
		const decoded = decodePayload(wire);
		if (
			decoded.kind === 'mailing_address' &&
			decoded.payload.country === 'DE' &&
			decoded.payload.street === 'Hauptstraße 42' &&
			decoded.payload.street2 === 'Hinterhof Aufgang 3' &&
			decoded.payload.state === 'Berlin' &&
			decoded.payload.recipientName === 'Max Mustermann' &&
			decoded.payload.note === 'Klingel 12 — bitte zweimal klingeln' &&
			decoded.payload.orderPermlink === 'order-abc-123'
		) {
			pass('M-2 full-fields roundtrip with German characters');
		} else {
			fail('M-2 full-fields roundtrip', `decoded: ${JSON.stringify(decoded)}`);
		}
	} catch (e) {
		fail('M-2 full-fields roundtrip', `threw: ${e}`);
	}
}

// M-3: invalid country code
try {
	encodeMailingAddressPayload({
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'usa',  // lowercase, wrong
		street: '123',
		city: 'X',
		postalCode: '1'
	});
	fail('M-3 encoder rejects invalid country code', 'expected throw, got no throw');
} catch {
	pass('M-3 encoder rejects invalid country code (lowercase)');
}

// M-4: empty street
try {
	encodeMailingAddressPayload({
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'US',
		street: '',
		city: 'X',
		postalCode: '1'
	});
	fail('M-4 encoder rejects empty street', 'expected throw, got no throw');
} catch {
	pass('M-4 encoder rejects empty street');
}

// M-5: oversize street
try {
	encodeMailingAddressPayload({
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'US',
		street: 'X'.repeat(201),
		city: 'Y',
		postalCode: '1'
	});
	fail('M-5 encoder rejects oversize street', 'expected throw, got no throw');
} catch {
	pass('M-5 encoder rejects oversize street (>200 chars)');
}

// M-6: encoded → decoded identity check
{
	const p: MailingAddressPayload = {
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'FR',
		street: '10 rue de la Paix',
		city: 'Paris',
		postalCode: '75002'
	};
	const wire = encodeMailingAddressPayload(p);
	const decoded = decodePayload(wire);
	if (decoded.kind === 'mailing_address') {
		pass('M-6 decoder produces mailing_address kind for encoded payload');
	} else {
		fail('M-6 decoder produces mailing_address kind', `got kind: ${decoded.kind}`);
	}
}

// M-7: malformed JSON falls through to plaintext
{
	const decoded = decodePayload('not even JSON {{{');
	if (decoded.kind === 'plaintext') {
		pass('M-7 decoder falls through to plaintext on malformed JSON');
	} else {
		fail('M-7 plaintext fallback on malformed JSON', `got: ${decoded.kind}`);
	}
}

// M-8: too-short postal code
{
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'US',
		street: '1',
		city: '1',
		postal_code: ''
	});
	const decoded = decodePayload(wire);
	if (decoded.kind === 'plaintext') {
		pass('M-8 decoder rejects empty postal code (falls through to plaintext)');
	} else {
		fail('M-8 reject empty postal code', `got: ${decoded.kind}`);
	}
}

// M-9: oversize note via wire (synthesize JSON to bypass encoder)
{
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_mailing_address',
		country: 'US',
		street: '1',
		city: '1',
		postal_code: '1',
		note: 'X'.repeat(501)
	});
	const decoded = decodePayload(wire);
	if (decoded.kind === 'plaintext') {
		pass('M-9 decoder rejects oversize note (>500 chars)');
	} else {
		fail('M-9 reject oversize note', `got: ${decoded.kind}`);
	}
}

// ─── Shipment scenarios ────────────────────────────────────────

// S-1: USPS canonical roundtrip
{
	const p: ShipmentPayload = {
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'usps',
		tracking: '9400 1234 5678 9012 3456 78'
	};
	try {
		const wire = encodeShipmentPayload(p);
		const decoded = decodePayload(wire);
		if (
			decoded.kind === 'shipment' &&
			decoded.payload.carrier === 'usps' &&
			decoded.payload.tracking === '9400 1234 5678 9012 3456 78'
		) {
			pass('S-1 USPS canonical-carrier roundtrip with spaced tracking');
		} else {
			fail('S-1 USPS roundtrip', `decoded: ${JSON.stringify(decoded)}`);
		}
	} catch (e) {
		fail('S-1 USPS roundtrip', `threw: ${e}`);
	}
}

// S-2: 'other' with custom carrier + URL
{
	const p: ShipmentPayload = {
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'other',
		tracking: 'XYZ-123-456',
		customCarrierName: 'Acme Couriers',
		customTrackingUrl: 'https://acme.example/track?id=XYZ-123-456'
	};
	try {
		const wire = encodeShipmentPayload(p);
		const decoded = decodePayload(wire);
		if (
			decoded.kind === 'shipment' &&
			decoded.payload.carrier === 'other' &&
			decoded.payload.customCarrierName === 'Acme Couriers' &&
			decoded.payload.customTrackingUrl === 'https://acme.example/track?id=XYZ-123-456'
		) {
			pass(`S-2 'other' carrier with customCarrierName + customTrackingUrl roundtrip`);
		} else {
			fail(`S-2 'other' carrier roundtrip`, `decoded: ${JSON.stringify(decoded)}`);
		}
	} catch (e) {
		fail(`S-2 'other' carrier roundtrip`, `threw: ${e}`);
	}
}

// S-3: invalid carrier key (uppercase rejected)
try {
	encodeShipmentPayload({
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'USPS',
		tracking: '123456789'
	});
	fail('S-3 encoder rejects uppercase carrier key', 'expected throw, got no throw');
} catch {
	pass('S-3 encoder rejects uppercase carrier key');
}

// S-4: too-short tracking
try {
	encodeShipmentPayload({
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'usps',
		tracking: '1234'
	});
	fail('S-4 encoder rejects too-short tracking', 'expected throw, got no throw');
} catch {
	pass('S-4 encoder rejects too-short tracking (<5 chars)');
}

// S-5: too-long tracking
try {
	encodeShipmentPayload({
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'usps',
		tracking: 'X'.repeat(51)
	});
	fail('S-5 encoder rejects too-long tracking', 'expected throw, got no throw');
} catch {
	pass('S-5 encoder rejects too-long tracking (>50 chars)');
}

// S-6: non-https customTrackingUrl
try {
	encodeShipmentPayload({
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'other',
		tracking: 'ABC123',
		customCarrierName: 'X',
		customTrackingUrl: 'http://insecure.example/track'
	});
	fail('S-6 encoder rejects non-https customTrackingUrl', 'expected throw, got no throw');
} catch {
	pass('S-6 encoder rejects non-https customTrackingUrl');
}

// S-7: encoded → decoded identity check
{
	const p: ShipmentPayload = {
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'china_post_ems',
		tracking: 'EE123456789CN'
	};
	const wire = encodeShipmentPayload(p);
	const decoded = decodePayload(wire);
	if (decoded.kind === 'shipment' && decoded.payload.carrier === 'china_post_ems') {
		pass('S-7 decoder accepts encoded shipment payload identity');
	} else {
		fail('S-7 decoder identity', `got: ${decoded.kind}`);
	}
}

// S-8: javascript: URL injection rejection via decoder
{
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_shipment',
		carrier: 'other',
		tracking: 'ABC123',
		custom_tracking_url: 'javascript:alert(1)'
	});
	const decoded = decodePayload(wire);
	if (decoded.kind === 'plaintext') {
		pass('S-8 decoder rejects javascript: scheme in custom_tracking_url');
	} else {
		fail('S-8 reject javascript: URL', `got: ${decoded.kind}`);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nshipping-payload-roundtrip smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} shipping-payload-roundtrip scenarios passed`);
