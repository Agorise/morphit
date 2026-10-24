/**
 * Morphit — the block explorers a HIDDEN site links to (v1.21.15).
 *
 * A visitor of a `.onion`, `.i2p` or `.loki` page is there to stay off the
 * clearnet: a payment's "view on explorer" link must not send them to a
 * clearnet website. So such a page links only to explorers that are Tor or
 * I2P services themselves, from these lists; where a coin has none, it shows
 * no link (the transaction id stays on the page to copy).
 *
 *   - `.onion` page → ONION list;
 *   - `.i2p` page   → I2P list first, then the ONION list (an I2P visitor with
 *                     Tor Browser can still use those);
 *   - `.loki` page  → the ONION list (there are no Lokinet explorers);
 *   - clearnet page → unchanged: the clearnet lists in urlsCore.ts.
 *
 * Every address here was opened in Tor Browser / an I2P browser by the
 * maintainer and loaded; the ones that did not load in that check are left
 * out (among them RunBTC's and nix-bitcoin's mempool onions, the only Decred
 * onion found and a Zcash and a Blockscout onion). No working Tor or I2P
 * explorer is known for Decred or Pirate Chain, so those show no link.
 *
 * The page format of each: mempool / Esplora and the Monero explorers
 * (onion-monero-blockchain-explorer) `/tx/{txid}`; Blockchair and 3xpl
 * `/<chain>/transaction/{txid}` — their onions serve the same paths as their
 * clearnet sites.
 *
 * Pure: no Svelte store, so tests and smokes import it directly.
 */

import { isHiddenServiceHost } from './urlsCore';

const BLOCKCHAIR = 'http://blkchairbknpn73cfjhevhla7rkp4ed5gg2knctvv7it4lioy22defid.onion';
const THREEXPL = 'http://3xplor3rzajysy4j5fi3g3k27vivfcw75zjxdb2tg2wpz3i4cdiyhxyd.onion';
/** Blockchair, then 3xpl, for one chain slug (the same on both). */
const multi = (slug: string): readonly string[] => [
	`${BLOCKCHAIR}/${slug}/transaction/{txid}`,
	`${THREEXPL}/${slug}/transaction/{txid}`
];

/** The assets a hidden page may link an explorer for: the native coins
 *  (urls.ts ExternalAsset) and the token networks (urlsCore.ts
 *  TOKEN_NETWORK_EXPLORER_URLS keys). */
export type HiddenExplorerKey =
	| 'BTC'
	| 'XMR'
	| 'BCH'
	| 'LTC'
	| 'DASH'
	| 'DOGE'
	| 'ZEC'
	| 'ARRR'
	| 'DCR'
	| 'SOL'
	| 'ETH'
	| 'XRP'
	| 'erc20'
	| 'trc20'
	| 'spl'
	| 'bep20'
	| 'base'
	| 'polygon'
	| 'arbitrum';

/** Tor explorers, best first. */
export const ONION_EXPLORER_URLS: Readonly<Record<HiddenExplorerKey, readonly string[]>> =
	Object.freeze({
		BTC: [
			// mempool.space (official)
			'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/tx/{txid}',
			// Blockstream (Esplora)
			'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion/tx/{txid}',
			// mempool.emzy.de
			'http://mempool4t6mypeemozyterviq3i5de4kpoua65r3qkn5i3kknu5l2cad.onion/tx/{txid}',
			// mempool.foundation.xyz (Foundation Devices)
			'http://3pd56qzgyg7p4sk7rlcxrrsbx7nfucdckautxjqbre7uw7kr3ah53byd.onion/tx/{txid}',
			// mempool.cakewallet.com (Cake Wallet)
			'http://cakememcninjdqbaub3tp2iswuigxqtdoevnpgzkolmy4gvhrrsub3yd.onion/tx/{txid}',
			...multi('bitcoin')
		],
		XMR: [
			// xmr.mx
			'http://ravfxexpx76quysu77pbvao4ng5qnyo46gguklfwlafhllrujwdgqtyd.onion/tx/{txid}',
			// P2Pool.io's explorer (served under /explorer/)
			'http://yucmgsbw7nknw7oi3bkuwudvc657g2xcqahhbjyewazusyytapqo4xid.onion/explorer/tx/{txid}',
			...multi('monero')
		],
		BCH: multi('bitcoin-cash'),
		LTC: multi('litecoin'),
		DASH: multi('dash'),
		DOGE: multi('dogecoin'),
		// The Zcash community lists Blockchair's Zcash explorer as not working:
		// 3xpl first.
		ZEC: [`${THREEXPL}/zcash/transaction/{txid}`, `${BLOCKCHAIR}/zcash/transaction/{txid}`],
		ARRR: [],
		DCR: [],
		SOL: multi('solana'),
		ETH: multi('ethereum'),
		XRP: multi('xrp-ledger'),
		erc20: multi('ethereum'),
		trc20: multi('tron'),
		spl: multi('solana'),
		bep20: multi('bnb'),
		base: multi('base'),
		polygon: multi('polygon'),
		arbitrum: multi('arbitrum-one')
	});

/** I2P explorers, best first (only Bitcoin and Monero have any). */
export const I2P_EXPLORER_URLS: Readonly<Partial<Record<HiddenExplorerKey, readonly string[]>>> =
	Object.freeze({
		// RunBTC's mempool (a Bisq bonded role)
		BTC: ['http://44naenfnp6foaegpmujdn4pmhtgo52tjkgs2d3ir2wo7d7mfbufq.b32.i2p/tx/{txid}'],
		XMR: [
			// xmr.mx
			'http://ravfxexpucy437tc4slicbf5atir2akrcqanog3tgsc3mcdfmrqq.b32.i2p/tx/{txid}',
			// moneroexamples
			'http://7o4gezpkye6ekibhgpkg7v626ze4idsirapufzrefkdysa6zxhha.b32.i2p/tx/{txid}'
		]
	});

/** Which network the page was opened on, by its host name. PURE. */
export type PageNetwork = 'clearnet' | 'onion' | 'i2p' | 'loki';
export function pageNetworkOf(hostname: string | null | undefined): PageNetwork {
	if (typeof hostname !== 'string') return 'clearnet';
	// A fully qualified name ends in a dot (`x.onion.`): the same network.
	const h = hostname.toLowerCase().replace(/\.$/, '');
	if (h.endsWith('.onion')) return 'onion';
	if (h.endsWith('.i2p')) return 'i2p';
	if (h.endsWith('.loki')) return 'loki';
	return 'clearnet';
}

/** The network of the page this code runs in ('clearnet' off the browser). */
export function currentPageNetwork(): PageNetwork {
	try {
		return typeof window === 'undefined' ? 'clearnet' : pageNetworkOf(window.location?.hostname);
	} catch {
		return 'clearnet';
	}
}

/** Is `url` on a Tor v3 onion or an I2P host (a hidden service)? PURE. */
export function isHiddenServiceUrl(url: string): boolean {
	try {
		const u = new URL(url);
		// Only a web link (v1.21.15 review): `javascript://<onion>/…` has an
		// onion hostname too.
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		return isHiddenServiceHost(u.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** The hidden explorer templates for `key` on a page of `network`, best
 *  first; null on a clearnet page (the clearnet lists apply). PURE. */
export function hiddenExplorerTemplates(
	key: HiddenExplorerKey,
	network: PageNetwork
): readonly string[] | null {
	if (network === 'clearnet') return null;
	const onion = ONION_EXPLORER_URLS[key] ?? [];
	if (network === 'i2p') return [...(I2P_EXPLORER_URLS[key] ?? []), ...onion];
	return onion;
}

/**
 * May the operator's explorer template be offered on a page of `network`?
 * PURE. (v1.21.15 review)
 *   - clearnet page: never a `.onion` / `.i2p` / `.loki` one (a clearnet
 *     browser cannot open it, and clicking an `.i2p` link hands the name to
 *     the visitor's resolver);
 *   - `.onion` / `.loki` page: only a Tor v3 onion (what Tor Browser opens);
 *   - `.i2p` page: an I2P or a Tor v3 onion one.
 */
export function overrideFitsPage(template: string, network: PageNetwork): boolean {
	let h: string;
	try {
		const u = new URL(template.replace(/\{txid\}/g, '0'));
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		h = u.hostname.toLowerCase().replace(/\.$/, '');
	} catch {
		return false;
	}
	const onion = /^[a-z2-7]{56}\.onion$/.test(h);
	const i2p = isHiddenServiceHost(h) && h.endsWith('.i2p');
	if (network === 'clearnet') return !/\.(onion|i2p|loki)$/.test(h);
	if (network === 'i2p') return onion || i2p;
	return onion;
}
