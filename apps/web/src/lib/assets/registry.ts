/**
 * Morphit — frontend asset registry.
 *
 * Single source of truth for per-coin UI metadata.  Every
 * component that displays a ticker, renders a themed accent
 * color, validates an address, or picks decimal precision
 * looks up its data here.
 *
 * Adding a new coin to the frontend UI is a single-file change
 * (this file) plus an SVG logo bundled at static/coins/<lower
 * ticker>.svg.
 *
 * IMPORTANT: this registry exists for UI rendering.  The
 * on-chain payload schema (see lib/chat/payload.ts and
 * lib/orders/payload.ts) constrains which methods a chain op
 * may carry.  Extending that schema is a separate, more
 * involved process — see docs/ADDING-A-COIN.md.  This registry
 * lets you wire UI for an already-supported coin or stage UI
 * for an upcoming chain-payload extension.
 */

import type { ChatAssetTicker } from '$lib/chat/payload';

/** Address-shape validator.  Returns true if the string LOOKS
 *  like a valid address for this asset.  Must NOT require a
 *  network round-trip; this is for inline form-validation UX.
 *  Indexer-side and explorer-side verification still happens
 *  independently. */
export type AddressValidator = (s: string) => boolean;

/** Per-asset metadata.  All fields required so the registry is
 *  self-describing — components don't need to check for
 *  missing fields, and the next person adding a coin sees the
 *  full required shape at a glance. */
export interface AssetMetadata {
	/** Lower-case identifier matching the chain payload's
	 *  ChatAssetTicker string union. */
	readonly ticker: ChatAssetTicker;
	/** Display ticker (uppercase, e.g. "BTC"). */
	readonly displayTicker: string;
	/** Full name (e.g. "Bitcoin"). */
	readonly displayName: string;
	/** One-line description shown in pickers and tooltips. */
	readonly oneLineDescription: string;
	/** SVG logo path relative to the static root.  Components
	 *  prefix with the served origin or use as-is for inline
	 *  <img src=...>.  Always 1:1 aspect ratio. */
	readonly logoSvgPath: string;
	/** Tailwind utility class for the brand accent color.  Used
	 *  for borders, dot indicators, hover rings.  Keep these
	 *  contained to one or two utilities; full styling is the
	 *  consumer's call. */
	readonly accentClass: string;
	/** How many decimal places this asset's smallest unit
	 *  represents.  BTC: 8 (sat).  XMR: 12 (piconero).  BLURT: 3
	 *  (millibBLURT — Graphene's serialized format). */
	readonly decimals: number;
	/** True if the asset supports a memo/payment-id field on its
	 *  base-layer transaction.  Drives whether the address-share
	 *  modal exposes a memo input. */
	readonly supportsMemo: boolean;
	/** Address validator — synchronous, no I/O.  Should be
	 *  permissive (cheap shape check) rather than strict
	 *  (checksum-verify): we want to catch typos in the form,
	 *  not duplicate the wallet's own validation. */
	readonly addressValidator: AddressValidator;
	/** Whether the asset can be used for the LISTING-FEE payment
	 *  on this instance.  Memory #23 (2026-05-13): only BLURT/
	 *  BTC/XMR may have this true.  Trade-only assets (USDT,
	 *  ARRR, etc.) MUST set this false. */
	readonly canBeUsedForListingFee: boolean;
	/** Whether the asset can be the TRADED asset (the side: 'buy
	 *  X' / 'sell X' driver of the orderbook).  All current
	 *  assets can; reserved for future "fee-only" or "stable-
	 *  only" tickers. */
	readonly canBeTraded: boolean;
	/** Networks this asset is supported on.  Single-network assets
	 *  use `['mainnet']`.  Multi-network assets (future USDT, etc.)
	 *  list each.  Mirrors the canonical registry's
	 *  `supportedNetworks`. */
	readonly supportedNetworks: readonly string[];
	/** Default network or `null` to force explicit user choice. */
	readonly defaultNetwork: string | null;
	/** i18n key for the privacy/decentralization warning chip,
	 *  or null if no warning is needed (BTC/XMR/BLURT). */
	readonly privacyWarningKey: string | null;
}

// ─── Address validators ──────────────────────────────────────────

// BTC — re-export the cheap shape checks from chat/payload.ts so
// we don't duplicate.  Centralizing here would mean chat/payload
// imports from registry, but registry imports from chat/payload
// for the ChatAssetTicker type — circular.  Inline copies stay.
const BTC_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BTC_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BTC_BECH32_RE = /^bc1[023456789acdefghjklmnpqrstuvwxyz]{6,87}$/;

const XMR_STANDARD_RE = /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/;
const XMR_SUBADDRESS_RE = /^8[0-9A-B][1-9A-HJ-NP-Za-km-z]{93}$/;
const XMR_INTEGRATED_RE = /^4[1-9A-HJ-NP-Za-km-z]{105}$/;

// Blurt account name — validates as the recipient identifier
// since BLURT transfers are routed by account name, not a hex
// address.
const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;

const validateBtc: AddressValidator = (s) =>
	BTC_P2PKH_RE.test(s) || BTC_P2SH_RE.test(s) || BTC_BECH32_RE.test(s);

const validateXmr: AddressValidator = (s) =>
	XMR_STANDARD_RE.test(s) || XMR_SUBADDRESS_RE.test(s) || XMR_INTEGRATED_RE.test(s);

const validateBlurt: AddressValidator = (s) => BLURT_ACCOUNT_RE.test(s);

// USDT per-network address shapes.  See lib/assets/networks.ts
// for the per-network metadata used by the address-share modal;
// THIS validator is the any-network combined check (passes if
// the string is a plausibly-valid USDT address on ANY supported
// network).  Per-network pinning is the address-share modal's
// job, not this validator's.
const USDT_ERC20_OR_BEP20_RE = /^0x[a-fA-F0-9]{40}$/;
const USDT_TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const USDT_SPL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const validateUsdt: AddressValidator = (s) =>
	USDT_ERC20_OR_BEP20_RE.test(s) ||
	USDT_TRC20_RE.test(s) ||
	USDT_SPL_RE.test(s);

// BCH — CashAddr (with or without `bitcoincash:` prefix) and
// legacy P2PKH/P2SH.  Inlined copies mirroring chat/payload.ts
// (we can't import to avoid the same registry-imports-payload
// circular).
const BCH_CASHADDR_PREFIXED_RE = /^bitcoincash:[qp][a-z0-9]{41}$/;
const BCH_CASHADDR_BARE_RE = /^[qp][a-z0-9]{41}$/;
const BCH_LEGACY_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BCH_LEGACY_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;

const validateBch: AddressValidator = (s) =>
	BCH_CASHADDR_PREFIXED_RE.test(s) ||
	BCH_CASHADDR_BARE_RE.test(s) ||
	BCH_LEGACY_P2PKH_RE.test(s) ||
	BCH_LEGACY_P2SH_RE.test(s);

// LTC — legacy P2PKH (L...), modern P2SH (M...), deprecated P2SH
// (3..., BTC-shape ambiguous per ADR-0025 §4), bech32/bech32m
// (ltc1...).  Inlined copies mirroring chat/payload.ts.
const LTC_LEGACY_P2PKH_RE = /^L[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_M_RE = /^M[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_3_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_BECH32_RE = /^ltc1[02-9ac-hj-np-z]{6,87}$/;

const validateLtc: AddressValidator = (s) =>
	LTC_LEGACY_P2PKH_RE.test(s) ||
	LTC_LEGACY_P2SH_M_RE.test(s) ||
	LTC_LEGACY_P2SH_3_RE.test(s) ||
	LTC_BECH32_RE.test(s);

// DASH address regex (cp27).  P2PKH starts with `X`, P2SH starts
// with `7`; both base58, 34 chars total.  Permissive shape check
// — receiving wallet does checksum and chain-binding.  See
// payload.ts and the canonical asset-registry entry for the full
// rationale.
const DASH_P2PKH_RE = /^X[1-9A-HJ-NP-Za-km-z]{33}$/;
const DASH_P2SH_RE = /^7[1-9A-HJ-NP-Za-km-z]{33}$/;

const validateDash: AddressValidator = (s) =>
	DASH_P2PKH_RE.test(s) || DASH_P2SH_RE.test(s);

// ─── Registry ────────────────────────────────────────────────────

/** The full registry, ordered for display purposes (Monero
 *  first per the project's audience-priority statement;
 *  Bitcoin second; BLURT last because it's the chain-of-record,
 *  not the typical traded asset). */
export const ASSETS: ReadonlyArray<AssetMetadata> = [
	{
		ticker: 'xmr',
		displayTicker: 'XMR',
		displayName: 'Monero',
		oneLineDescription: 'Privacy-focused cryptocurrency.  Default and recommended on Morphit.',
		logoSvgPath: '/coins/xmr.svg',
		accentClass: 'text-orange-500',
		decimals: 12,
		supportsMemo: false, // Subaddresses replace payment-IDs in modern XMR
		addressValidator: validateXmr,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'btc',
		displayTicker: 'BTC',
		displayName: 'Bitcoin',
		oneLineDescription: 'The original cryptocurrency.  Recommend SegWit (bc1...) addresses.',
		logoSvgPath: '/coins/btc.svg',
		accentClass: 'text-amber-500',
		decimals: 8,
		supportsMemo: false, // BTC doesn't carry transaction memos
		addressValidator: validateBtc,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'blurt',
		displayTicker: 'BLURT',
		displayName: 'Blurt',
		oneLineDescription: 'The chain Morphit coordinates on.  Used for network fees by default.',
		logoSvgPath: '/coins/blurt.svg',
		accentClass: 'text-morphit-emerald',
		decimals: 3,
		supportsMemo: true, // BLURT transfers carry a plaintext memo field
		addressValidator: validateBlurt,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'usdt',
		displayTicker: 'USDT',
		displayName: 'Tether',
		oneLineDescription:
			'Stablecoin pegged to USD.  Centrally controlled.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/coins/usdt.svg',
		// Amber to mirror the privacy-warning chip's visual treatment.
		// Distinguishes USDT from BTC's amber (BTC is amber-500;
		// USDT is amber-400 — slightly lighter to read as "warning"
		// vs "branded yellow").
		accentClass: 'text-amber-400',
		decimals: 6, // Same on all four supported networks
		supportsMemo: false,
		addressValidator: validateUsdt,
		// MEMORY #23 INVARIANT: USDT cannot pay listing fees.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Multi-network: ERC-20, TRC-20, SPL, BEP-20.
		// Native USDT only — bridged versions excluded.
		supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20'],
		// null forces explicit user choice every trade.
		// Cross-network sends lose funds permanently.
		defaultNetwork: null,
		privacyWarningKey: 'usdt_centralized'
	},
	{
		ticker: 'bch',
		displayTicker: 'BCH',
		displayName: 'Bitcoin Cash',
		oneLineDescription:
			'Bitcoin Cash — bigger blocks, lower per-tx fees.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-bch.svg',
		// BCH brand green.  text-lime-500 is visually distinct from
		// BLURT's text-morphit-emerald, XMR's text-orange-500, BTC's
		// text-amber-500, USDT's text-amber-400.  Reads as "green"
		// (the Bitcoin Cash community color) without colliding.
		accentClass: 'text-lime-500',
		decimals: 8, // Same as BTC — sat-denominated smallest unit
		supportsMemo: false, // BCH transactions don't carry memos (same as BTC)
		addressValidator: validateBch,
		// MEMORY #23 INVARIANT: BCH cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// BCH is transparent (like BTC) but decentralized — no
		// issuer can freeze addresses.  Same posture as BTC: no
		// privacy warning chip.
		privacyWarningKey: null
	},
	{
		ticker: 'ltc',
		displayTicker: 'LTC',
		displayName: 'Litecoin',
		oneLineDescription:
			'Litecoin — fast, low-fee Bitcoin fork.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-ltc.svg',
		// LTC brand silver/gray.  text-slate-400 reads as the
		// Litecoin "silver" without colliding with BCH's lime-500,
		// BTC's amber-500, USDT's amber-400, XMR's orange-500, or
		// BLURT's morphit-emerald.
		accentClass: 'text-slate-400',
		decimals: 8, // Same as BTC — litoshi == satoshi
		supportsMemo: false, // LTC transactions don't carry memos (same as BTC)
		addressValidator: validateLtc,
		// MEMORY #23 INVARIANT: LTC cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// LTC is transparent (like BTC and BCH) but decentralized —
		// no issuer can freeze addresses.  Same posture as BTC: no
		// privacy warning chip.  (LTC has MWEB opt-in privacy but
		// it's wallet-side and per-tx, not a chain property; users
		// seeking strongest privacy posture should use XMR.)
		privacyWarningKey: null
	},
	{
		ticker: 'dash',
		displayTicker: 'DASH',
		displayName: 'Dash',
		oneLineDescription:
			'Dash — fast-confirmation transparent chain with opt-in PrivateSend mixing.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-dash.svg',
		// DASH brand blue (#008CE7).  text-sky-500 reads as the
		// Dash blue without colliding with BCH lime-500, LTC
		// slate-400, BTC amber-500, USDT amber-400, XMR orange-500,
		// or BLURT morphit-emerald.
		accentClass: 'text-sky-500',
		decimals: 8, // Same as BTC — duff == satoshi
		supportsMemo: false, // DASH transactions don't carry memos (same as BTC)
		addressValidator: validateDash,
		// MEMORY #23 INVARIANT: DASH cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// DASH is transparent at the base layer (like BTC/BCH/LTC)
		// and fully decentralized — no issuer can freeze
		// addresses.  Same posture as BTC: no privacy warning chip.
		// DASH does ship an opt-in privacy upgrade — PrivateSend,
		// a masternode-coordinated CoinJoin variant — but it's
		// wallet-side and per-tx, not a chain property; users
		// seeking strongest privacy posture should use XMR, and
		// users who want transparent + opt-in mixing can pre-mix
		// via PrivateSend before sharing the address on Morphit.
		privacyWarningKey: null
	}
] as const;

const BY_TICKER: Readonly<Record<ChatAssetTicker, AssetMetadata>> = Object.freeze(
	ASSETS.reduce(
		(acc, a) => {
			acc[a.ticker] = a;
			return acc;
		},
		{} as Record<ChatAssetTicker, AssetMetadata>
	)
);

/** Look up a registered asset by its lower-case ticker.  Throws
 *  if the ticker isn't registered — caller should pass values
 *  from the ChatAssetTicker type union, which is constrained by
 *  the chain-payload schema. */
export function getAsset(ticker: ChatAssetTicker): AssetMetadata {
	const a = BY_TICKER[ticker];
	if (a === undefined) {
		throw new Error(
			`getAsset: ticker '${ticker}' not in registry — register it in lib/assets/registry.ts`
		);
	}
	return a;
}

/** Filter helpers for common UI-side queries. */
export function tradeableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.canBeTraded);
}

export function feePayableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.canBeUsedForListingFee);
}

export function memoCapableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.supportsMemo);
}
