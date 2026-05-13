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
	BLURT_TRXID_RE,
	ACCOUNT_NAME_RE,
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL,
	substituteTxidIntoTemplate
} from './urlsCore';

export {
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL
} from './urlsCore';

export type ExternalAsset = 'BTC' | 'XMR';

/** Builds an external-explorer URL for a non-Blurt asset's
 *  transaction.  Returns null on validation failure.
 *
 *  Reads the instance store synchronously for the operator's
 *  configured template.  When the store hasn't loaded yet (SSR,
 *  pre-hydration), or when the operator hasn't configured a
 *  template, falls back to the bundled default. */
export function externalExplorerUrl(asset: ExternalAsset, txid: string): string | null {
	if (typeof txid !== 'string') return null;
	const lower = txid.toLowerCase();
	if (asset === 'BTC') {
		if (!BTC_TXID_RE.test(txid)) return null;
		const tpl = getInstanceSnapshot().chat_link_urls.btc ?? BUNDLED_BTC_CHAT_LINK_URL;
		return substituteTxidIntoTemplate(tpl, lower);
	}
	if (asset === 'XMR') {
		if (!XMR_TXID_RE.test(txid)) return null;
		const tpl = getInstanceSnapshot().chat_link_urls.xmr ?? BUNDLED_XMR_CHAT_LINK_URL;
		return substituteTxidIntoTemplate(tpl, lower);
	}
	return null;
}

/** Builds the Morphit explorer URL for a Blurt transaction.
 *  Returns null on validation failure. */
export function morphitExplorerTxUrl(trxId: string): string | null {
	if (typeof trxId !== 'string' || !BLURT_TRXID_RE.test(trxId)) return null;
	return `/explorer/tx/${trxId.toLowerCase()}`;
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
