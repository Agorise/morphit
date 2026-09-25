/**
 * v1.18.0 deep-deep, M1 — the post page must never quote a listing fee below
 * the chain-pinned floor the indexer enforces (pinned × (1 − FEE_PRICE_TOLERANCE)),
 * whatever /v1/listing-fee says. rv6 A6: a sybil-steered federated price made a
 * hidden-only node quote ~1.25 BLURT against a floor of ~106.
 */
import { describe, expect, it } from 'vitest';
import {
	FEE_PRICE_TOLERANCE,
	minAcceptablePiconero,
	minAcceptableSatoshis
} from '@morphit/asset-registry';
import { boundedBlurtBase, boundedPiconero, boundedSatoshis } from './feeQuoteFloor';
import { computeFee } from './fee';

const PIN = 125;

describe('boundedBlurtBase', () => {
	it('a sybil-low quote is lifted to the enforced floor (and the broadcast amount clears it)', () => {
		const base = boundedBlurtBase(1.25, 60, PIN);
		const floor = PIN * (1 - FEE_PRICE_TOLERANCE);
		expect(base).toBeGreaterThanOrEqual(floor);
		// What the page actually broadcasts for a 1st order.
		expect(Number(computeFee(1, base).blurtFormatted.split(' ')[0])).toBeGreaterThanOrEqual(floor);
	});
	it('a fallback constant below a higher pin is lifted too', () => {
		expect(boundedBlurtBase(undefined, 60, PIN)).toBeGreaterThanOrEqual(
			PIN * (1 - FEE_PRICE_TOLERANCE)
		);
	});
	it('a sybil-high quote is capped at pin × (1 + T) (no 10× overpay)', () => {
		expect(boundedBlurtBase(1250, 60, PIN)).toBeCloseTo(PIN * (1 + FEE_PRICE_TOLERANCE), 9);
	});
	it('an in-band live quote passes through unchanged', () => {
		expect(boundedBlurtBase(118, 60, PIN)).toBe(118);
	});
	it('with no pinned base the quote passes through', () => {
		expect(boundedBlurtBase(1.25, 60, null)).toBe(1.25);
		expect(boundedBlurtBase(undefined, 60, undefined)).toBe(60);
	});
});

describe('boundedSatoshis / boundedPiconero', () => {
	it('never quote BTC below the satoshi floor the verifier enforces', () => {
		const q = boundedSatoshis(3, 416);
		expect(q).toBeGreaterThanOrEqual(minAcceptableSatoshis(416));
		expect(boundedSatoshis(5000, 416)).toBeLessThanOrEqual(
			Math.floor(416 * (1 + FEE_PRICE_TOLERANCE))
		);
		expect(boundedSatoshis(420, 416)).toBe(420);
		expect(boundedSatoshis(undefined, 416)).toBeUndefined();
	});
	it('never quote XMR below the piconero floor the verifier enforces', () => {
		const pin = '781250000';
		const q = boundedPiconero('1000', pin)!;
		expect(BigInt(q)).toBeGreaterThanOrEqual(minAcceptablePiconero(BigInt(pin)));
		expect(boundedPiconero('781250001', pin)).toBe('781250001');
		expect(boundedPiconero(undefined, pin)).toBeUndefined();
	});
});
