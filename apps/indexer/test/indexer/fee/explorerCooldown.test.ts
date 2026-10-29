/**
 * An explorer that cannot be reached goes on the pool's cooldown ladder
 * (v1.21.17). The fee checks throw Error('transport_failure') for it, meaning
 * exactly that — but the pool did not count the bare word as a transport
 * failure, so a dead explorer was asked again, and waited out, on every check.
 */
import { describe, expect, it, vi } from 'vitest';
import { isTransportError, TRANSPORT_FAILURE } from '@morphit/rpc-pool';
import { BitcoinExplorerFeeVerifier } from '../../../src/indexer/fee/bitcoinExplorerVerifier';

const FEE_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const TXID = 'a'.repeat(64);

describe('explorer cooldown', () => {
	it('the pool counts transport_failure as a transport error', () => {
		expect(TRANSPORT_FAILURE).toBe('transport_failure');
		expect(isTransportError(new Error('transport_failure'))).toBe(true);
		expect(isTransportError(new Error('data_malformed'))).toBe(false);
	});

	it('a dead explorer is not asked again on the next check', async () => {
		const calls = new Map<string, number>();
		const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = typeof input === 'string' ? input : input.toString();
			const host = new URL(url).host;
			calls.set(host, (calls.get(host) ?? 0) + 1);
			if (host === 'dead.example') throw new TypeError('fetch failed');
			return new Response(
				JSON.stringify({
					txid: TXID,
					vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
					status: { confirmed: true, block_height: 800_000 }
				}),
				{ status: 200 }
			);
		}) as unknown as typeof fetch;
		const verifier = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://dead.example/api', 'https://alive.example/api'],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				minSuccessfulResponses: 1
			},
			fetchImpl
		);
		const claim = {
			feeMethod: 'btc' as const,
			expectedAmount: 2_500,
			externalTxId: TXID,
			permlink: 'order-1',
			signer: 'alice'
		};
		await verifier.verify(claim as never);
		const deadFirst = calls.get('dead.example') ?? 0;
		expect(deadFirst).toBeGreaterThan(0);
		await verifier.verify(claim as never);
		expect(calls.get('dead.example') ?? 0).toBe(deadFirst);
	});
});
