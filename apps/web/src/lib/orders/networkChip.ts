/**
 * Morphit — the multi-network asset chip.
 *
 * USDT, USDC and DAI exist on several chains. Which chain an order means is not
 * decoration: send TRC20 USDT to an ERC20 address and the money is gone. So an
 * order card for a multi-network asset MUST name its network.
 *
 * This derivation used to live inline in the orderbook page's row loop, twelve
 * lines of nested ternaries per row. That's why the FEATURED strip — which
 * renders through the same shared `OrderCard` — showed no network chip at all:
 * `networkChip` is a prop, the featured list never passed one, and there was no
 * function to call, only a block to remember to copy.
 */

import { isUsdtNetwork, isUsdcNetwork, isDaiNetwork } from '$lib/assets/networks';
import type { OrderRecord } from '@morphit/indexer-client';

export type NetworkChipTone = 'usdt' | 'usdc' | 'dai';

export interface NetworkChip {
	readonly label: string;
	readonly tone: NetworkChipTone;
}

/** Minimal translate signature — matches svelte-i18n's `$_`. */
type Translate = (key: string) => unknown;

/**
 * The network chip for an order, or null when the asset is single-network (or
 * the order carries an unrecognised network, in which case showing nothing is
 * safer than showing a guess).
 */
export function networkChipFor(order: OrderRecord, t: Translate): NetworkChip | null {
	const net = order.asset_network;
	if (!net) return null;

	if (order.asset === 'USDT' && isUsdtNetwork(net)) {
		return { label: String(t(`assets.usdt.network.${net}.displayName`)), tone: 'usdt' };
	}
	if (order.asset === 'USDC' && isUsdcNetwork(net)) {
		return { label: String(t(`assets.usdc.network.${net}.displayName`)), tone: 'usdc' };
	}
	if (order.asset === 'DAI' && isDaiNetwork(net)) {
		return { label: String(t(`assets.dai.network.${net}.displayName`)), tone: 'dai' };
	}
	return null;
}
