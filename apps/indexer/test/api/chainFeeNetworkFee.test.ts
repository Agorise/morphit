/**
 * /v1/chain-fee carries the network fee (v1.21.17): every Blurt transaction
 * pays a flat fee per operation plus a fee per kB, from liquid BLURT. The
 * Feature form adds it to the bid before saying the balance covers it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetChainFeeCache, chainFeeRoute } from '$api/chainFee';

const blurt = (props: Record<string, unknown> | Error) => ({
	callCondenser: async () => {
		if (props instanceof Error) throw props;
		return props;
	}
});
const ask = async (props: Record<string, unknown> | Error) => {
	const res = await chainFeeRoute(blurt(props) as never, {} as never).request('/');
	return (await res.json()) as Record<string, unknown>;
};

afterEach(() => _resetChainFeeCache());

describe('/v1/chain-fee network fee', () => {
	it('reports the per-operation and per-kB fee the chain sets', async () => {
		const body = await ask({
			account_creation_fee: '100.000 BLURT',
			operation_flat_fee: '0.050 BLURT',
			bandwidth_kbytes_fee: '0.200 BLURT'
		});
		expect(body).toMatchObject({
			account_creation_fee_blurt: 100,
			operation_flat_fee_blurt: 0.05,
			bandwidth_kbytes_fee_blurt: 0.2,
			source: 'chain'
		});
	});

	it('null when the node leaves them out or the chain cannot be read', async () => {
		expect(await ask({ account_creation_fee: '100.000 BLURT' })).toMatchObject({
			operation_flat_fee_blurt: null,
			bandwidth_kbytes_fee_blurt: null
		});
		_resetChainFeeCache();
		expect(await ask(new Error('down'))).toMatchObject({
			source: 'fallback',
			operation_flat_fee_blurt: null,
			bandwidth_kbytes_fee_blurt: null
		});
	});

	it('an implausible rate from the one node asked is dropped (the browser uses the known ones)', async () => {
		expect(
			await ask({
				account_creation_fee: '100.000 BLURT',
				operation_flat_fee: '100000.000 BLURT',
				bandwidth_kbytes_fee: '1.001 BLURT'
			})
		).toMatchObject({ operation_flat_fee_blurt: null, bandwidth_kbytes_fee_blurt: null });
		_resetChainFeeCache();
		expect(
			await ask({
				account_creation_fee: '100.000 BLURT',
				operation_flat_fee: '1.000 BLURT',
				bandwidth_kbytes_fee: '0.000 BLURT'
			})
		).toMatchObject({ operation_flat_fee_blurt: 1, bandwidth_kbytes_fee_blurt: 0 });
	});

	it('a fallback is asked again within minutes, not a day', async () => {
		vi.useFakeTimers();
		try {
			let n = 0;
			const flaky = {
				callCondenser: async () => {
					n++;
					if (n === 1) throw new Error('down');
					return { account_creation_fee: '100.000 BLURT', operation_flat_fee: '0.050 BLURT' };
				}
			};
			const app = chainFeeRoute(flaky as never, {} as never);
			const first = await app.request('/');
			expect(((await first.json()) as { source: string }).source).toBe('fallback');
			expect(first.headers.get('cache-control')).toBe('public, max-age=300');
			vi.advanceTimersByTime(11 * 60 * 1000);
			const again = (await (await app.request('/')).json()) as { source: string };
			expect(again.source).toBe('chain');
		} finally {
			vi.useRealTimers();
		}
	});
});
