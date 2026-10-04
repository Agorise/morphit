/**
 * Which listing-fee methods the post form offers follows the instance's own
 * /v1/instance `treasury`: a null address means the indexer refuses that
 * method's fees (hidden-only node, operator turned it off, no explorer).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false, version: 't' }));

import { feeMethodsFromWire } from './instance';

describe('feeMethodsFromWire', () => {
	it('an address takes the method, null does not', () => {
		expect(feeMethodsFromWire({ btc: 'bc1qxyz', xmr: null })).toEqual({ btc: true, xmr: false });
		expect(feeMethodsFromWire({ btc: null, xmr: '4Abc' })).toEqual({ btc: false, xmr: true });
		expect(feeMethodsFromWire({ btc: '', xmr: '  ' })).toEqual({ btc: false, xmr: false });
	});
	it('no treasury field (older indexer) is unknown, not "off"', () => {
		expect(feeMethodsFromWire(undefined)).toEqual({ btc: null, xmr: null });
		expect(feeMethodsFromWire({})).toEqual({ btc: null, xmr: null });
	});
});
