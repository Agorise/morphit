import { describe, expect, it } from 'vitest';
import { networkChipFor } from './networkChip';
import type { OrderRecord } from '@morphit/indexer-client';

const t = (k: string) => k; // identity translator: assert on the KEY
const order = (asset: string, asset_network: string | null) =>
	({ asset, asset_network }) as unknown as OrderRecord;

describe('networkChipFor', () => {
	it('names the network for a multi-network asset', () => {
		expect(networkChipFor(order('USDT', 'trc20'), t)).toEqual({
			label: 'assets.usdt.network.trc20.displayName',
			tone: 'usdt'
		});
		expect(networkChipFor(order('USDC', 'erc20'), t)?.tone).toBe('usdc');
		expect(networkChipFor(order('DAI', 'erc20'), t)?.tone).toBe('dai');
	});

	it('returns null for single-network assets', () => {
		expect(networkChipFor(order('BLURT', null), t)).toBeNull();
		expect(networkChipFor(order('XMR', null), t)).toBeNull();
	});

	it('shows nothing rather than guessing on an unrecognised network', () => {
		// Better a missing chip than a wrong one: the network decides where money lands.
		expect(networkChipFor(order('USDT', 'not-a-chain'), t)).toBeNull();
	});

	it('does not attach a USDT network to a different asset', () => {
		expect(networkChipFor(order('USDC', 'trc20'), t)).toBeNull();
	});

	it('is null when asset_network is absent even for a multi-network asset', () => {
		expect(networkChipFor(order('USDT', null), t)).toBeNull();
	});
});
