/**
 * Morphit indexer — whether THIS node takes BTC / XMR listing fees, and which
 * explorers it may ask, in which order.
 *
 * A node takes a BTC (XMR) fee only when all of these hold:
 *   - MORPHIT_INDEXER_{BTC,XMR}_FEE_ADDRESS is not set to an empty value. An
 *     explicit empty value is the operator's way to turn the method off, and
 *     it wins over an address pinned on chain: the chain pin decides WHERE a
 *     fee is paid, never WHETHER a node takes it.
 *   - At least one explorer is usable. An empty explorer list turns the method
 *     off (it used to make the verifier constructor throw on every loop once
 *     a release pinned an address, so the node stopped indexing).
 *   - On a hidden-only node (no clearnet RPC; it reads the chain over Tor and
 *     I2P), only explorers it can reach without clearnet are usable: onion /
 *     I2P services, and an explorer on this box itself. Its clearnet entries
 *     are dropped, never contacted. The shipped default list has onion
 *     explorers for both methods, so a zero-clearnet node takes BTC and XMR
 *     fees; it only advertises them while one of those answers (the poller's
 *     source-health probe, fee/feeSourceHealth.ts).
 *
 * The usable explorers are asked in two tiers: first the ones that need no
 * clearnet (`firstTierUrls`: onion, I2P, this box), then — only where clearnet
 * is allowed and only when the first tier cannot answer — all of them.
 *
 * A method this returns as off has no verifier; /v1/instance then advertises
 * its treasury address as null, so neither peers nor the client offer it here.
 */
import { isClearnetSource } from '$indexer/sourceFetch';

export type ExternalFeeMethod = 'btc' | 'xmr';

export type ExternalFeeOffReason = 'disabled_by_operator' | 'no_explorers' | 'no_hidden_explorers';

export interface ExternalFeeAvailability {
	/** Null when the method is on. */
	readonly off: ExternalFeeOffReason | null;
	/** The explorers this node may ask (empty when off), as configured. */
	readonly explorerUrls: readonly string[];
	/** Those among them that need no clearnet: asked first. */
	readonly firstTierUrls: readonly string[];
}

interface FeeConfig {
	readonly blurtRpcEndpoints: readonly unknown[];
	readonly hiddenRpcEndpoints: readonly unknown[];
	readonly btcFeeAddress: string;
	readonly btcExplorerUrls: readonly string[];
	readonly xmrFeeAddress: string;
	readonly xmrExplorerUrls: readonly string[];
}

/** True when this node reads the chain over hidden services only. */
export function isHiddenOnlyNode(config: FeeConfig): boolean {
	return config.blurtRpcEndpoints.length === 0 && config.hiddenRpcEndpoints.length > 0;
}

/** True when the node must not touch clearnet: no clearnet RPC at all (the
 *  same rule as the process router's fail-closed policy). */
function zeroClearnet(config: FeeConfig): boolean {
	return config.blurtRpcEndpoints.length === 0;
}

/** An explorer entry's URL without the XMR kind prefix. */
function urlOf(spec: string): string {
	return spec.trim().replace(/^(raw-tx|node)\+/, '');
}

/** PURE. */
export function externalFeeAvailability(
	config: FeeConfig,
	method: ExternalFeeMethod
): ExternalFeeAvailability {
	const address = method === 'btc' ? config.btcFeeAddress : config.xmrFeeAddress;
	const all = method === 'btc' ? config.btcExplorerUrls : config.xmrExplorerUrls;
	const none = { explorerUrls: [], firstTierUrls: [] };
	if (address.trim().length === 0) return { off: 'disabled_by_operator', ...none };
	if (all.length === 0) return { off: 'no_explorers', ...none };
	const noClearnet = all.filter((u) => !isClearnetSource(urlOf(u)));
	if (zeroClearnet(config)) {
		if (noClearnet.length === 0) return { off: 'no_hidden_explorers', ...none };
		return { off: null, explorerUrls: noClearnet, firstTierUrls: noClearnet };
	}
	return { off: null, explorerUrls: all, firstTierUrls: noClearnet };
}
