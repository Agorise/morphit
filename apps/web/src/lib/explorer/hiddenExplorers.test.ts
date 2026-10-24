/**
 * v1.21.15 — a hidden site (.onion / .i2p / .loki) links payments only to
 * Tor / I2P explorers, never to a clearnet one; a clearnet site is unchanged.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({
	value: {
		chat_link_urls: {
			btc: null as string | null,
			xmr: null as string | null,
			bch: null as string | null,
			ltc: null as string | null,
			dash: null as string | null,
			doge: null as string | null,
			zec: null as string | null,
			arrr: null as string | null,
			dcr: null as string | null,
			sol: null as string | null,
			eth: null as string | null,
			xrp: null as string | null,
			usdt: { erc20: null, trc20: null, spl: null, bep20: null } as Record<string, string | null>,
			usdc: { erc20: null, spl: null, base: null, polygon: null } as Record<string, string | null>,
			dai: { erc20: null, polygon: null, base: null, arbitrum: null } as Record<
				string,
				string | null
			>
		}
	}
}));
vi.mock('$lib/stores/instance', () => ({ getInstanceSnapshot: () => snapshot.value }));

import {
	I2P_EXPLORER_URLS,
	ONION_EXPLORER_URLS,
	hiddenExplorerTemplates,
	isHiddenServiceUrl,
	overrideFitsPage,
	pageNetworkOf,
	type HiddenExplorerKey
} from './hiddenExplorers';
import {
	BUNDLED_BTC_CHAT_LINK_URLS,
	isHiddenServiceHost,
	isValidChatLinkTemplate
} from './urlsCore';
import {
	blurtWalletExplorerFallbackUrl,
	daiExplorerUrl,
	daiExplorerUrls,
	externalExplorerUrl,
	externalExplorerUrls,
	usdcExplorerUrl,
	usdcExplorerUrls,
	usdtExplorerUrl,
	usdtExplorerUrls,
	type ExternalAsset
} from './urls';

const HEX = 'ab'.repeat(32);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Decode(s: string): Buffer {
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const c of s) {
		const v = B32.indexOf(c);
		if (v < 0) throw new Error(`not base32: ${c}`);
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** A real Tor v3 address: 32-byte key, 2-byte SHA3 checksum, version 3. */
function isRealV3Onion(host: string): boolean {
	const m = /^([a-z2-7]{56})\.onion$/.exec(host);
	if (!m) return false;
	const raw = base32Decode(m[1] ?? '');
	if (raw.length !== 35 || raw[34] !== 3) return false;
	const sum = createHash('sha3-256')
		.update(Buffer.concat([Buffer.from('.onion checksum'), raw.subarray(0, 32), Buffer.from([3])]))
		.digest();
	return sum[0] === raw[32] && sum[1] === raw[33];
}

const ALL_TEMPLATES = [
	...Object.values(ONION_EXPLORER_URLS).flat(),
	...Object.values(I2P_EXPLORER_URLS).flat()
];

const NATIVE: ExternalAsset[] = [
	'BTC',
	'XMR',
	'BCH',
	'LTC',
	'DASH',
	'DOGE',
	'ZEC',
	'ARRR',
	'DCR',
	'SOL',
	'ETH',
	'XRP'
];
const TXID: Record<ExternalAsset, string> = {
	BTC: HEX,
	XMR: HEX,
	BCH: HEX,
	LTC: HEX,
	DASH: HEX,
	DOGE: HEX,
	ZEC: HEX,
	ARRR: HEX,
	DCR: HEX,
	SOL: '5'.repeat(88),
	ETH: `0x${HEX}`,
	XRP: HEX.toUpperCase()
};

function setPageHost(hostname: string | null): void {
	if (hostname === null) vi.unstubAllGlobals();
	else vi.stubGlobal('window', { location: { hostname } });
}

/** Every link any builder makes for every asset on the current page. */
function everyLink(): string[] {
	const out: string[] = [];
	for (const a of NATIVE) {
		out.push(...externalExplorerUrls(a, TXID[a]));
		const one = externalExplorerUrl(a, TXID[a]);
		if (one) out.push(one);
	}
	const evm = `0x${HEX}`;
	for (const n of ['erc20', 'bep20'] as const) {
		out.push(...usdtExplorerUrls(n, evm));
		out.push(usdtExplorerUrl(n, evm) ?? '');
	}
	out.push(...usdtExplorerUrls('trc20', HEX), usdtExplorerUrl('trc20', HEX) ?? '');
	out.push(...usdtExplorerUrls('spl', TXID.SOL), usdtExplorerUrl('spl', TXID.SOL) ?? '');
	for (const n of ['erc20', 'base', 'polygon'] as const) {
		out.push(...usdcExplorerUrls(n, evm), usdcExplorerUrl(n, evm) ?? '');
	}
	for (const n of ['erc20', 'base', 'polygon', 'arbitrum'] as const) {
		out.push(...daiExplorerUrls(n, evm), daiExplorerUrl(n, evm) ?? '');
	}
	out.push(blurtWalletExplorerFallbackUrl('tx', 'a'.repeat(40)) ?? '');
	out.push(blurtWalletExplorerFallbackUrl('account', 'alice') ?? '');
	out.push(blurtWalletExplorerFallbackUrl('block', 5) ?? '');
	return out.filter((u) => u !== '');
}

function resetOverrides(): void {
	const c = snapshot.value.chat_link_urls;
	for (const k of [
		'btc',
		'xmr',
		'bch',
		'ltc',
		'dash',
		'doge',
		'zec',
		'arrr',
		'dcr',
		'sol',
		'eth',
		'xrp'
	] as const)
		c[k] = null;
	for (const m of [c.usdt, c.usdc, c.dai]) for (const k of Object.keys(m)) m[k] = null;
}

beforeEach(resetOverrides);
afterEach(() => vi.unstubAllGlobals());

describe('the hidden explorer addresses', () => {
	it('are real Tor v3 onions or 52-character b32.i2p names, over http, with {txid} in the path', () => {
		expect(ALL_TEMPLATES.length).toBeGreaterThan(20);
		for (const t of ALL_TEMPLATES) {
			const u = new URL(t.replace('{txid}', HEX));
			expect(u.protocol, t).toBe('http:');
			expect(
				u.hostname.endsWith('.onion')
					? isRealV3Onion(u.hostname)
					: /^[a-z2-7]{52}\.b32\.i2p$/.test(u.hostname),
				t
			).toBe(true);
			expect(new URL(t).hostname.includes('{txid}'), t).toBe(false);
			expect(t.split('/').slice(3).join('/')).toContain('{txid}');
			expect(isValidChatLinkTemplate(t), t).toBe(true);
			expect(isHiddenServiceUrl(t), t).toBe(true);
		}
	});

	it('use each explorer’s own transaction page format', () => {
		const bc = 'http://blkchairbknpn73cfjhevhla7rkp4ed5gg2knctvv7it4lioy22defid.onion';
		const x3 = 'http://3xplor3rzajysy4j5fi3g3k27vivfcw75zjxdb2tg2wpz3i4cdiyhxyd.onion';
		const slugs: Partial<Record<HiddenExplorerKey, string>> = {
			BTC: 'bitcoin',
			XMR: 'monero',
			BCH: 'bitcoin-cash',
			LTC: 'litecoin',
			DASH: 'dash',
			DOGE: 'dogecoin',
			ZEC: 'zcash',
			SOL: 'solana',
			ETH: 'ethereum',
			XRP: 'xrp-ledger',
			erc20: 'ethereum',
			trc20: 'tron',
			spl: 'solana',
			bep20: 'bnb',
			base: 'base',
			polygon: 'polygon',
			arbitrum: 'arbitrum-one'
		};
		for (const [key, slug] of Object.entries(slugs)) {
			const list = ONION_EXPLORER_URLS[key as HiddenExplorerKey];
			expect(list, key).toContain(`${bc}/${slug}/transaction/{txid}`);
			expect(list, key).toContain(`${x3}/${slug}/transaction/{txid}`);
		}
		for (const t of [...ONION_EXPLORER_URLS.BTC, ...(I2P_EXPLORER_URLS.BTC ?? [])]) {
			if (!t.startsWith(bc) && !t.startsWith(x3)) expect(t, t).toMatch(/\/tx\/\{txid\}$/);
		}
		expect(ONION_EXPLORER_URLS.XMR).toContain(
			'http://yucmgsbw7nknw7oi3bkuwudvc657g2xcqahhbjyewazusyytapqo4xid.onion/explorer/tx/{txid}'
		);
		expect(ONION_EXPLORER_URLS.ZEC[0]?.startsWith(x3)).toBe(true);
		expect(ONION_EXPLORER_URLS.DCR).toEqual([]);
		expect(ONION_EXPLORER_URLS.ARRR).toEqual([]);
	});

	it('leave out every address that did not load in the maintainer’s check', () => {
		const bad = [
			'runbtcx3wfyg',
			'4fyxfiqjn2sq',
			'btcexpz7xlwr',
			'exploredv42t',
			'2v3d5dlxm7ka',
			'zcashfgzdzxw',
			'dcrdata5oppw',
			'blockscoutlm'
		];
		for (const t of ALL_TEMPLATES)
			for (const b of bad) expect(t.includes(b), `${t} has ${b}`).toBe(false);
	});
});

describe('the page network', () => {
	it('is read from the host name', () => {
		expect(pageNetworkOf('abc.onion')).toBe('onion');
		expect(pageNetworkOf('ABC.ONION')).toBe('onion');
		expect(pageNetworkOf('abc.onion.'), 'a fully qualified name').toBe('onion');
		expect(pageNetworkOf('x.b32.i2p.')).toBe('i2p');
		expect(pageNetworkOf('x.b32.i2p')).toBe('i2p');
		expect(pageNetworkOf('x.loki')).toBe('loki');
		expect(pageNetworkOf('morphit.io')).toBe('clearnet');
		expect(pageNetworkOf('onion.example')).toBe('clearnet');
		expect(pageNetworkOf(undefined)).toBe('clearnet');
	});

	it('puts I2P explorers first on an I2P page, gives none on a clearnet page', () => {
		const i2p = hiddenExplorerTemplates('BTC', 'i2p') ?? [];
		expect(i2p[0]).toContain('.b32.i2p/');
		expect(i2p.slice(1)).toEqual([...ONION_EXPLORER_URLS.BTC]);
		expect(hiddenExplorerTemplates('BTC', 'loki')).toEqual(ONION_EXPLORER_URLS.BTC);
		expect(hiddenExplorerTemplates('BTC', 'clearnet')).toBeNull();
	});
});

describe('links on a hidden page', () => {
	for (const host of [
		'mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion',
		'aaaa.b32.i2p',
		'morphit.loki'
	]) {
		it(`are hidden services only on ${host}, even with clearnet overrides set`, () => {
			setPageHost(host);
			const c = snapshot.value.chat_link_urls;
			c.btc = 'https://clearnet.example/tx/{txid}';
			c.eth = 'https://clearnet.example/tx/{txid}';
			c.usdt.erc20 = 'https://clearnet.example/tx/{txid}';
			c.dai.arbitrum = 'https://clearnet.example/tx/{txid}';
			const links = everyLink();
			expect(links.length).toBeGreaterThan(40);
			for (const u of links) expect(isHiddenServiceUrl(u), u).toBe(true);
			expect(links.some((u) => u.includes('clearnet.example'))).toBe(false);
		});
	}

	it('show no link for Decred, Pirate Chain or the Blurt explorer fallback', () => {
		setPageHost('x.b32.i2p');
		expect(externalExplorerUrls('DCR', HEX)).toEqual([]);
		expect(externalExplorerUrl('ARRR', HEX)).toBeNull();
		expect(blurtWalletExplorerFallbackUrl('tx', 'a'.repeat(40))).toBeNull();
	});

	it('use a hidden operator override first and fill the txid in each format', () => {
		setPageHost('abc.onion');
		const own = 'http://3pd56qzgyg7p4sk7rlcxrrsbx7nfucdckautxjqbre7uw7kr3ah53byd.onion/tx/{txid}';
		snapshot.value.chat_link_urls.btc = own;
		const urls = externalExplorerUrls('BTC', HEX.toUpperCase());
		expect(urls[0]).toBe(own.replace('{txid}', HEX));
		expect(externalExplorerUrl('BTC', HEX)).toBe(urls[0]);
		expect(urls[1]).toBe(
			`http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/tx/${HEX}`
		);
		expect(usdtExplorerUrls('erc20', HEX)[0]).toBe(
			`http://blkchairbknpn73cfjhevhla7rkp4ed5gg2knctvv7it4lioy22defid.onion/ethereum/transaction/0x${HEX}`
		);
		expect(usdtExplorerUrl('trc20', HEX.toUpperCase())).toBe(
			`http://blkchairbknpn73cfjhevhla7rkp4ed5gg2knctvv7it4lioy22defid.onion/tron/transaction/${HEX}`
		);
		expect(usdcExplorerUrls('spl', TXID.SOL)[1]).toBe(
			`http://3xplor3rzajysy4j5fi3g3k27vivfcw75zjxdb2tg2wpz3i4cdiyhxyd.onion/solana/transaction/${TXID.SOL}`
		);
	});
});

describe('links on a clearnet page', () => {
	it('are unchanged', () => {
		setPageHost('morphit.io');
		expect(externalExplorerUrls('BTC', HEX)).toEqual(
			BUNDLED_BTC_CHAT_LINK_URLS.map((t) => t.replace('{txid}', HEX))
		);
		expect(blurtWalletExplorerFallbackUrl('block', 5)).toBe('https://blocks.blurtwallet.com/b/5');
		setPageHost(null);
		expect(blurtWalletExplorerFallbackUrl('block', 5)).toBe('https://blocks.blurtwallet.com/b/5');
	});
});

describe('an operator override is offered only on a page that can open it (v1.21.15 review)', () => {
	const ONION_TPL =
		'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/tx/{txid}';
	const I2P_TPL = 'http://44naenfnp6foaegpmujdn4pmhtgo52tjkgs2d3ir2wo7d7mfbufq.b32.i2p/tx/{txid}';
	it('clearnet page: a hidden override is skipped, the bundled list applies', () => {
		setPageHost('morphit.io');
		for (const tpl of [ONION_TPL, I2P_TPL]) {
			snapshot.value.chat_link_urls.btc = tpl;
			snapshot.value.chat_link_urls.usdt.erc20 = tpl;
			const all = [
				...externalExplorerUrls('BTC', HEX),
				externalExplorerUrl('BTC', HEX) ?? '',
				...usdtExplorerUrls('erc20', HEX),
				usdtExplorerUrl('erc20', HEX) ?? ''
			];
			expect(
				all.some((u) => isHiddenServiceUrl(u)),
				tpl
			).toBe(false);
			expect(externalExplorerUrl('BTC', HEX)).toBe(
				BUNDLED_BTC_CHAT_LINK_URLS[0]!.replace('{txid}', HEX)
			);
		}
	});
	it('.onion page: an I2P override is skipped (Tor Browser cannot open it)', () => {
		setPageHost('abc.onion');
		snapshot.value.chat_link_urls.btc = I2P_TPL;
		expect(externalExplorerUrls('BTC', HEX).some((u) => u.includes('.i2p/'))).toBe(false);
		snapshot.value.chat_link_urls.btc = ONION_TPL;
		expect(externalExplorerUrl('BTC', HEX)).toBe(ONION_TPL.replace('{txid}', HEX));
	});
	it('.i2p page: an I2P override comes first', () => {
		setPageHost('x.b32.i2p');
		snapshot.value.chat_link_urls.btc = I2P_TPL;
		expect(externalExplorerUrl('BTC', HEX)).toBe(I2P_TPL.replace('{txid}', HEX));
	});
});

describe('v1.21.15 review', () => {
	const ONION = 'mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion';
	const SOL_SIG =
		'5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
	it('a Solana signature keeps its case (base58), on a hidden and on a clearnet page', () => {
		setPageHost('abc.onion');
		expect(externalExplorerUrls('SOL', SOL_SIG).length).toBeGreaterThan(1);
		expect(externalExplorerUrls('SOL', SOL_SIG).every((u) => u.endsWith(`/${SOL_SIG}`))).toBe(true);
		expect(externalExplorerUrl('SOL', SOL_SIG)?.endsWith(`/${SOL_SIG}`)).toBe(true);
		setPageHost('morphit.io');
		expect(externalExplorerUrls('SOL', SOL_SIG).length).toBeGreaterThan(1);
		expect(externalExplorerUrls('SOL', SOL_SIG).every((u) => u.includes(SOL_SIG))).toBe(true);
	});
	it('an Ethereum hash gets its 0x prefix, on a hidden and on a clearnet page', () => {
		setPageHost('abc.onion');
		expect(externalExplorerUrls('ETH', HEX).length).toBeGreaterThan(1);
		expect(externalExplorerUrls('ETH', HEX).every((u) => u.endsWith(`/0x${HEX}`))).toBe(true);
		setPageHost('morphit.io');
		expect(externalExplorerUrls('ETH', HEX.toUpperCase()).length).toBeGreaterThan(1);
		expect(
			externalExplorerUrls('ETH', HEX.toUpperCase()).every((u) => u.includes(`0x${HEX}`))
		).toBe(true);
	});
	it('a javascript:// (or other non-web) link with an onion host is never a hidden-service link', () => {
		for (const u of [
			`javascript://${ONION}/%0Aalert(1)//x`,
			`ftp://${ONION}/x`,
			`data://${ONION}/x`
		]) {
			expect(isHiddenServiceUrl(u), u).toBe(false);
			expect(overrideFitsPage(u + '{txid}', 'onion'), u).toBe(false);
			expect(overrideFitsPage(u + '{txid}', 'i2p'), u).toBe(false);
			expect(overrideFitsPage(u + '{txid}', 'clearnet'), u).toBe(false);
		}
	});
	it('an override to a short (non-v3) .onion is not used on an .onion page', () => {
		setPageHost('abc.onion');
		snapshot.value.chat_link_urls.btc = 'https://short.onion/tx/{txid}';
		expect(externalExplorerUrls('BTC', HEX).some((u) => u.includes('short.onion'))).toBe(false);
		// Each of the two guards on its own (page fit, then the hidden-service filter).
		expect(overrideFitsPage('https://short.onion/tx/{txid}', 'onion')).toBe(false);
		expect(overrideFitsPage('https://short.onion/tx/{txid}', 'i2p')).toBe(false);
		expect(isHiddenServiceUrl('https://short.onion/tx/x')).toBe(false);
	});
	it('a .loki override is not used on a clearnet page', () => {
		setPageHost('morphit.io');
		snapshot.value.chat_link_urls.btc = 'https://x.loki/tx/{txid}';
		expect(externalExplorerUrls('BTC', HEX).some((u) => u.includes('.loki'))).toBe(false);
	});
	it('which override fits which page, every pairing', () => {
		const t = {
			clearnet: 'https://explorer.example/tx/{txid}',
			onion: `http://${ONION}/tx/{txid}`,
			i2p: 'http://explorer.i2p/tx/{txid}',
			b32: 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst.b32.i2p/tx/{txid}',
			loki: 'http://explorer.loki/tx/{txid}'
		};
		const fits = (k: keyof typeof t, page: 'clearnet' | 'onion' | 'i2p' | 'loki') =>
			overrideFitsPage(t[k], page);
		// A clearnet page: only a clearnet explorer.
		expect([
			fits('clearnet', 'clearnet'),
			fits('onion', 'clearnet'),
			fits('i2p', 'clearnet')
		]).toEqual([true, false, false]);
		expect([fits('b32', 'clearnet'), fits('loki', 'clearnet')]).toEqual([false, false]);
		// An .onion or .loki page: only a Tor v3 onion (never I2P, Lokinet or clearnet).
		for (const page of ['onion', 'loki'] as const) {
			expect(
				[
					fits('onion', page),
					fits('i2p', page),
					fits('b32', page),
					fits('loki', page),
					fits('clearnet', page)
				],
				page
			).toEqual([true, false, false, false, false]);
		}
		// An .i2p page: I2P or a Tor onion.
		expect([
			fits('i2p', 'i2p'),
			fits('b32', 'i2p'),
			fits('onion', 'i2p'),
			fits('loki', 'i2p'),
			fits('clearnet', 'i2p')
		]).toEqual([true, true, true, false, false]);
	});
	it('isHiddenServiceHost: an .i2p name needs a label before it', () => {
		expect(isHiddenServiceHost('explorer.i2p')).toBe(true);
		expect(isHiddenServiceHost('xi2p')).toBe(false);
		expect(isHiddenServiceHost('i2p')).toBe(false);
		expect(isHiddenServiceHost('.i2p')).toBe(false);
		expect(isHiddenServiceHost('x.i2p.example')).toBe(false);
		expect(isHiddenServiceHost(`${ONION}`)).toBe(true);
		expect(isHiddenServiceHost('short.onion')).toBe(false);
	});
});

describe('operator templates', () => {
	it('may use http only to a Tor v3 onion or an I2P host', () => {
		expect(
			isValidChatLinkTemplate(
				'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/tx/{txid}'
			)
		).toBe(true);
		expect(isValidChatLinkTemplate('http://xmr.kisu.i2p/tx/{txid}')).toBe(true);
		expect(isValidChatLinkTemplate('https://mempool.space/tx/{txid}')).toBe(true);
		expect(isValidChatLinkTemplate('http://mempool.space/tx/{txid}')).toBe(false);
		expect(isValidChatLinkTemplate('http://expyuzz4wqqyqhjn.onion/tx/{txid}')).toBe(false); // v2
		expect(isValidChatLinkTemplate('http://onion.example/tx/{txid}')).toBe(false);
		expect(isValidChatLinkTemplate('http://u:p@xmr.kisu.i2p/tx/{txid}')).toBe(false);
		expect(isValidChatLinkTemplate('javascript:alert(1)//{txid}')).toBe(false);
	});
});
