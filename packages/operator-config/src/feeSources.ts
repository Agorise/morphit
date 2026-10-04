/**
 * The default BTC / XMR fee explorers and price sources — ONE list, read by
 * the indexer's config defaults, its verifiers, the ops-cli wizard and the
 * upgrade's list heals. An operator overrides each list in the env
 * (MORPHIT_INDEXER_BTC_EXPLORER_URLS, MORPHIT_INDEXER_XMR_EXPLORER_URLS,
 * MORPHIT_INDEXER_PRICENODE_URLS); unset, these apply.
 *
 * Onion first. The indexer asks the onion sources over its own Tor SOCKS port,
 * on a fresh circuit per request, and turns to the clearnet ones only when the
 * onion ones cannot answer — and never on a zero-clearnet node, which drops
 * every clearnet entry. A zero-clearnet node therefore needs no third-party
 * clearnet service to verify fees or to price BTC and XMR.
 *
 * Checked live over Tor by the maintainer on 2026-10-02 (each answered HTTP
 * 200; times are one round trip through Tor):
 *   BTC (Esplora API under /api):
 *     mempool.space official 1.7 s, mempool emzy 8.7 s, mempool runbtc 5.4 s,
 *     Blockstream Esplora 24.9 s.
 *   XMR (onion-monero-blockchain-explorer, JSON API on — /api/networkinfo):
 *     runbtc 6.7 s, suddenwhipvapor 8.4 s.
 *   Prices (/getAllMarketPrices): Haveno 15.2 s, Haveno (Cake) 32.5 s,
 *     Haveno (Agorise) 9.4 s, Bisq alexej996 6.9 s, Bisq runbtc 8.8 s.
 * Left out: no answer at all — mempool devinbileck, xmrblocks
 * moneroexamples/xmrchain, xmrblocks emzy, xmrblocks devinbileck; answered
 * only with a web page, JSON API not shown to be on — Blockchair, xmr.mx,
 * P2Pool.io's explorer; not block explorers — the P2Pool observers; not
 * mainnet — the Monero stagenet and testnet explorers.
 */

/** Esplora API bases on Tor (`/tx/{txid}`, `/address/{a}`, `/blocks/tip/height`). */
export const DEFAULT_BTC_ONION_EXPLORERS: readonly string[] = [
	// mempool.space (official)
	'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api',
	// mempool.emzy.de
	'http://mempool4t6mypeemozyterviq3i5de4kpoua65r3qkn5i3kknu5l2cad.onion/api',
	// mempool, runbtc
	'http://runbtcx3wfygbq2wdde6qzjnpyrqn3gvbks7t5jdymmunxttdvvttpyd.onion/api',
	// Blockstream Esplora
	'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion/api'
] as const;

/** Clearnet Esplora API bases — the fallback, where clearnet is allowed. */
export const DEFAULT_BTC_CLEARNET_EXPLORERS: readonly string[] = [
	'https://blockstream.info/api',
	'https://mempool.space/api'
] as const;

/** The default MORPHIT_INDEXER_BTC_EXPLORER_URLS. */
export const DEFAULT_BTC_FEE_EXPLORERS: readonly string[] = [
	...DEFAULT_BTC_ONION_EXPLORERS,
	...DEFAULT_BTC_CLEARNET_EXPLORERS
];

/** onion-monero-blockchain-explorer instances on Tor: the same software as
 *  xmrchain.net, so the same JSON API (`/api/outputs?…&txprove=1`,
 *  `/api/transaction/<txid>`, `/api/networkinfo`). */
export const DEFAULT_XMR_ONION_EXPLORERS: readonly string[] = [
	// xmrblocks, runbtc
	'http://xmrexplrthytnunr4jasr3vnjc6jo5idsyxzv74a7ep7dy7lwcv2eoyd.onion',
	// xmrblocks, suddenwhipvapor
	'http://nklwsomtuok6dhqqecp3a26xzgokfgmeuaplcdkaxehncg57yzarvbad.onion'
] as const;

/**
 * Clearnet XMR sources — the fallback, where clearnet is allowed. Three kinds
 * (the indexer's config/xmrExplorers.ts has the details): `https://` an
 * explorer asked to prove the payment, `raw-tx+https://` an explorer that only
 * serves the raw transaction, `node+https://` a public Monero node. Checked
 * live 2026-09-28 (explorers) and 2026-10-01 (nodes).
 */
export const DEFAULT_XMR_CLEARNET_EXPLORERS: readonly string[] = [
	'https://xmrchain.net',
	'https://moneroexplorer.org',
	'raw-tx+https://moneroblocks.info',
	'node+https://xmr-node.cakewallet.com:18081',
	'node+https://node.monero.fail',
	'node+https://xmr.cryptostorm.is'
] as const;

/** The default MORPHIT_INDEXER_XMR_EXPLORER_URLS. */
export const DEFAULT_XMR_FEE_EXPLORERS: readonly string[] = [
	...DEFAULT_XMR_ONION_EXPLORERS,
	...DEFAULT_XMR_CLEARNET_EXPLORERS
];

/**
 * Haveno and Bisq pricenodes on Tor (`GET <base>/getAllMarketPrices`): the
 * default MORPHIT_INDEXER_PRICENODE_URLS. BTC and XMR prices in every fiat, and
 * the USD→fiat table, are the consensus of these (median, at least two
 * agreeing, a majority of those that answered).
 */
export const DEFAULT_PRICENODES: readonly string[] = [
	// Haveno
	'http://elaxlgigphpicy5q7pi5wkz2ko2vgjbq4576vic7febmx4xcxvk6deqd.onion',
	// Haveno (Cake)
	'http://lrrgpezvdrbpoqvkavzobmj7dr2otxc5x6wgktrw337bk6mxsvfp5yid.onion',
	// Haveno (Agorise)
	'http://agorise7ae5g7lkqp7r7qddsyzskft7cqhgguwkadbqamtsrap5onead.onion',
	// Bisq, alexej996
	'http://ro7nv73awqs3ga2qtqeqawrjpbxwarsazznszvr6whv7tes5ehffopid.onion',
	// Bisq, runbtc
	'http://runbtcpn7gmbj5rgqeyfyvepqokrijem6rbw7o5wgqbguimuoxrmcdyd.onion'
] as const;

/** Is `url`'s host a Tor v3 onion or an I2P name (a hidden service)? PURE.
 *  Any scheme prefix like `raw-tx+` / `node+` is skipped. */
export function isHiddenSourceUrl(url: string): boolean {
	const s = url.trim().replace(/^(raw-tx|node)\+/, '');
	try {
		const h = new URL(s).hostname.toLowerCase();
		return /^[a-z2-7]{56}\.onion$/.test(h) || h.endsWith('.i2p');
	} catch {
		return false;
	}
}

/**
 * Is `url` an acceptable fee-explorer or price-source URL? PURE. `https://`
 * anywhere, or `http://` to a hidden service (Tor and I2P encrypt and
 * authenticate end to end; a hidden service is normally served over plain
 * HTTP). Never credentials in the URL. Any `raw-tx+` / `node+` prefix is the
 * caller's to strip first.
 */
export function isAcceptableSourceUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return false;
	}
	if (u.username !== '' || u.password !== '') return false;
	if (u.protocol === 'https:') return true;
	return u.protocol === 'http:' && isHiddenSourceUrl(url);
}
