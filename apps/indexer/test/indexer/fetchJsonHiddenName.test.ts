/**
 * v1.21.15 — the clearnet fetch never resolves a Tor / I2P / Lokinet name:
 * the lookup would hand the name to the system resolver (and on to the ISP's).
 * Such peers are reached through Tor / i2pd only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setDnsResolverForTesting, fetchJson } from '$indexer/federationProbe';

const ONION = 'a'.repeat(56) + '.onion';
afterEach(() => _setDnsResolverForTesting(null));

describe('fetchJson and hidden names', () => {
	it.each([
		[`https://${ONION}/v1/price-receipt`],
		[`https://${ONION}./v1/price-receipt`],
		['https://short.onion/x'],
		['https://peer.b32.i2p/x'],
		['https://peer.i2p/x'],
		['https://peer.loki/x']
	])('%s is refused before any lookup', async (url) => {
		const asked: string[] = [];
		_setDnsResolverForTesting(async (h: string) => {
			asked.push(h);
			throw new Error('looked up');
		});
		await expect(fetchJson(url)).rejects.toThrow(/hidden-service name/);
		expect(asked).toEqual([]);
	});

	it('a clearnet name is still looked up (and checked) as before', async () => {
		const asked: string[] = [];
		_setDnsResolverForTesting(async (h: string) => {
			asked.push(h);
			throw new Error('looked up');
		});
		await expect(fetchJson('https://peer.example/x')).rejects.toThrow(/looked up/);
		expect(asked).toEqual(['peer.example']);
	});
});
